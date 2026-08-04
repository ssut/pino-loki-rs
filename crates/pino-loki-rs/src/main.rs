mod batcher;
mod builder;
mod config;
mod pusher;
mod stats;

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use clap::Parser;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::{mpsc, Notify};

use crate::builder::Builder;
use crate::config::{Config, DropPolicy};
use crate::stats::Stats;

fn default_headers(cfg: &Config) -> HeaderMap {
    let mut headers = HeaderMap::new();
    for raw in &cfg.headers {
        match raw.split_once('=') {
            Some((name, value)) => match (
                HeaderName::from_bytes(name.trim().as_bytes()),
                HeaderValue::from_str(value.trim()),
            ) {
                (Ok(name), Ok(value)) => {
                    headers.insert(name, value);
                }
                _ => tracing::warn!(header = %raw, "invalid_header_ignored"),
            },
            None => tracing::warn!(header = %raw, "invalid_header_ignored"),
        }
    }
    if let Some(tenant) = &cfg.tenant {
        match HeaderValue::from_str(tenant) {
            Ok(value) => {
                headers.insert(HeaderName::from_static("x-scope-orgid"), value);
            }
            Err(_) => tracing::warn!("invalid_tenant_ignored"),
        }
    }
    headers
}

fn spawn_stats_reporter(cfg: &Config, stats: &Arc<Stats>, queue_len: &Arc<AtomicUsize>) {
    if cfg.stats_interval_ms == 0 {
        return;
    }
    let stats = stats.clone();
    let queue_len = queue_len.clone();
    let interval_ms = cfg.stats_interval_ms;
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_millis(interval_ms));
        tick.tick().await;
        loop {
            tick.tick().await;
            tracing::info!(
                queue = queue_len.load(Ordering::Relaxed) as u64,
                read_lines = stats.read_lines.load(Ordering::Relaxed),
                entries_delivered = stats.entries_delivered.load(Ordering::Relaxed),
                batches_sent = stats.batches_sent.load(Ordering::Relaxed),
                retries = stats.retries.load(Ordering::Relaxed),
                entries_dropped_queue = stats.entries_dropped_queue.load(Ordering::Relaxed),
                entries_dropped_delivery = stats.entries_dropped_delivery.load(Ordering::Relaxed),
                parse_errors = stats.parse_errors.load(Ordering::Relaxed),
                "stats_snapshot"
            );
        }
    });
}

#[tokio::main]
async fn main() {
    let cfg = Arc::new(Config::parse());
    tracing_subscriber::fmt()
        .json()
        .with_writer(std::io::stderr)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let started = Instant::now();
    let extra_labels: BTreeMap<String, String> = cfg
        .labels
        .as_deref()
        .and_then(|s| serde_json::from_str::<serde_json::Map<String, Value>>(s).ok())
        .map(|m| {
            m.into_iter()
                .map(|(k, v)| {
                    (
                        k,
                        match v {
                            Value::String(s) => s,
                            other => other.to_string(),
                        },
                    )
                })
                .collect()
        })
        .unwrap_or_default();
    let props: Vec<String> = cfg
        .props_to_labels
        .as_deref()
        .map(|s| {
            s.split(',')
                .map(|p| p.trim().to_string())
                .filter(|p| !p.is_empty())
                .collect()
        })
        .unwrap_or_default();

    let builder = Builder {
        extra_labels,
        props_to_labels: props,
        replace_timestamp: cfg.replace_timestamp,
        convert_arrays: cfg.convert_arrays,
        structured_meta_key: cfg.structured_meta_key.clone(),
    };

    let mut client_builder = reqwest::Client::builder()
        .timeout(Duration::from_millis(cfg.timeout_ms))
        .default_headers(default_headers(&cfg));
    if cfg.http2 {
        client_builder = client_builder.http2_prior_knowledge();
    }
    let client = client_builder.build().expect("http client build failed");
    let url = Arc::new(format!(
        "{}/loki/api/v1/push",
        cfg.host.trim_end_matches('/')
    ));

    let stats = Arc::new(Stats::default());
    let queue_len = Arc::new(AtomicUsize::new(0));
    let notify = Arc::new(Notify::new());
    let drain_deadline = Arc::new(AtomicU64::new(0));
    let (tx, rx) = mpsc::unbounded_channel();

    tracing::info!(
        host = %cfg.host,
        interval_ms = cfg.interval_ms,
        max_batch = cfg.max_batch,
        queue_cap = cfg.queue_cap,
        drop_policy = ?cfg.drop_policy,
        max_retries = cfg.max_retries,
        max_inflight = cfg.max_inflight,
        drain_max_ms = cfg.drain_max_ms,
        tenant = cfg.tenant.as_deref().unwrap_or(""),
        http2 = cfg.http2,
        compression = ?cfg.compression,
        "pino_loki_rs_started"
    );

    spawn_stats_reporter(&cfg, &stats, &queue_len);

    let batcher_handle = tokio::spawn(batcher::run(
        batcher::BatcherCtx {
            cfg: cfg.clone(),
            stats: stats.clone(),
            queue_len: queue_len.clone(),
            notify: notify.clone(),
            client,
            url,
            drain_deadline: drain_deadline.clone(),
        },
        rx,
    ));

    let mut segments = BufReader::with_capacity(1 << 20, tokio::io::stdin()).split(b'\n');
    loop {
        match segments.next_segment().await {
            Ok(Some(seg)) => {
                if seg.is_empty() {
                    continue;
                }
                stats.read_lines.fetch_add(1, Ordering::Relaxed);
                match serde_json::from_slice::<Value>(&seg) {
                    Ok(Value::Object(map)) => {
                        let built = builder.build(map);
                        match cfg.drop_policy {
                            DropPolicy::Block => loop {
                                if queue_len.load(Ordering::Relaxed) < cfg.queue_cap {
                                    break;
                                }
                                let mut waiter = std::pin::pin!(notify.notified());
                                waiter.as_mut().enable();
                                if queue_len.load(Ordering::Relaxed) < cfg.queue_cap {
                                    break;
                                }
                                waiter.await;
                            },
                            DropPolicy::Newest => {
                                if queue_len.load(Ordering::Relaxed) >= cfg.queue_cap {
                                    stats.entries_dropped_queue.fetch_add(1, Ordering::Relaxed);
                                    continue;
                                }
                            }
                            DropPolicy::Oldest => {}
                        }
                        queue_len.fetch_add(1, Ordering::Relaxed);
                        if tx.send(built).is_err() {
                            break;
                        }
                    }
                    _ => {
                        stats.parse_errors.fetch_add(1, Ordering::Relaxed);
                    }
                }
            }
            Ok(None) => break,
            Err(e) => {
                tracing::warn!(error = %e, "stdin_read_error");
                break;
            }
        }
    }
    drain_deadline.store(
        pusher::epoch_ms().saturating_add(cfg.drain_max_ms),
        Ordering::Relaxed,
    );
    drop(tx);
    let _ = batcher_handle.await;

    let final_stats = serde_json::json!({
        "event": "final_stats",
        "read_lines": stats.read_lines.load(Ordering::Relaxed),
        "parse_errors": stats.parse_errors.load(Ordering::Relaxed),
        "entries_delivered": stats.entries_delivered.load(Ordering::Relaxed),
        "batches_sent": stats.batches_sent.load(Ordering::Relaxed),
        "retries": stats.retries.load(Ordering::Relaxed),
        "entries_dropped_queue": stats.entries_dropped_queue.load(Ordering::Relaxed),
        "batches_dropped_delivery": stats.batches_dropped_delivery.load(Ordering::Relaxed),
        "entries_dropped_delivery": stats.entries_dropped_delivery.load(Ordering::Relaxed),
        "elapsed_ms": started.elapsed().as_millis() as u64,
    });
    eprintln!("{final_stats}");
}
