use std::collections::VecDeque;
use std::io::Write;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;

use bytes::Bytes;
use tokio::sync::{mpsc, Notify, OwnedSemaphorePermit, Semaphore};
use tokio::time::{interval, timeout, Duration, MissedTickBehavior};

use crate::builder::{payload, BuiltLog};
use crate::config::{Compression, Config, DropPolicy};
use crate::pusher;
use crate::stats::Stats;

pub struct BatcherCtx {
    pub cfg: Arc<Config>,
    pub stats: Arc<Stats>,
    pub queue_len: Arc<AtomicUsize>,
    pub notify: Arc<Notify>,
    pub client: reqwest::Client,
    pub url: Arc<String>,
    pub drain_deadline: Arc<AtomicU64>,
}

struct SealedBatch {
    body: Bytes,
    entries: u64,
}

pub fn compress_gzip(data: &[u8]) -> Vec<u8> {
    let mut encoder = flate2::write::GzEncoder::new(
        Vec::with_capacity(data.len() / 4),
        flate2::Compression::fast(),
    );
    let _ = encoder.write_all(data);
    encoder.finish().unwrap_or_default()
}

pub async fn run(ctx: BatcherCtx, mut rx: mpsc::UnboundedReceiver<BuiltLog>) {
    let sem = Arc::new(Semaphore::new(ctx.cfg.max_inflight));
    let batch_size = ctx.cfg.max_batch.max(1);
    let mut deque: VecDeque<BuiltLog> = VecDeque::new();
    let mut sealed: VecDeque<SealedBatch> = VecDeque::new();
    let mut sealed_entries: usize = 0;
    let mut tick = interval(Duration::from_millis(ctx.cfg.interval_ms.max(1)));
    tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut open = true;
    let mut interval_due = false;
    while open || !deque.is_empty() || !sealed.is_empty() {
        tokio::select! {
            msg = rx.recv(), if open => {
                match msg {
                    Some(log) => {
                        deque.push_back(log);
                        if matches!(ctx.cfg.compression, Compression::Gzip)
                            && deque.len() >= batch_size.saturating_mul(2)
                        {
                            let batch: Vec<BuiltLog> = deque.drain(..batch_size).collect();
                            let (body, entries) = payload(batch);
                            let compressed = compress_gzip(body.as_bytes());
                            tracing::debug!(entries, raw = body.len(), sealed = compressed.len(), "batch_sealed");
                            sealed_entries += entries as usize;
                            sealed.push_back(SealedBatch { body: Bytes::from(compressed), entries });
                        }
                        if matches!(ctx.cfg.drop_policy, DropPolicy::Oldest)
                            && deque.len() + sealed_entries > ctx.cfg.queue_cap
                        {
                            if let Some(block) = sealed.pop_front() {
                                sealed_entries -= block.entries as usize;
                                ctx.queue_len.fetch_sub(block.entries as usize, Ordering::Relaxed);
                                ctx.stats.entries_dropped_queue.fetch_add(block.entries, Ordering::Relaxed);
                            } else if deque.pop_front().is_some() {
                                ctx.queue_len.fetch_sub(1, Ordering::Relaxed);
                                ctx.stats.entries_dropped_queue.fetch_add(1, Ordering::Relaxed);
                            }
                            ctx.notify.notify_waiters();
                        }
                    }
                    None => {
                        open = false;
                        interval_due = true;
                    }
                }
            }
            _ = tick.tick() => {
                if !deque.is_empty() || !sealed.is_empty() {
                    interval_due = true;
                }
            }
            permit = sem.clone().acquire_owned(), if !sealed.is_empty() || (!deque.is_empty() && (interval_due || deque.len() >= batch_size)) => {
                let permit = permit.expect("semaphore closed");
                if let Some(block) = sealed.pop_front() {
                    sealed_entries -= block.entries as usize;
                    dispatch(&ctx, block.body, block.entries, permit);
                } else {
                    let take = deque.len().min(batch_size);
                    let batch: Vec<BuiltLog> = deque.drain(..take).collect();
                    let (body, entries) = payload(batch);
                    let bytes = match ctx.cfg.compression {
                        Compression::Gzip => Bytes::from(compress_gzip(body.as_bytes())),
                        Compression::None => Bytes::from(body),
                    };
                    dispatch(&ctx, bytes, entries, permit);
                }
                if deque.is_empty() && sealed.is_empty() {
                    interval_due = false;
                }
            }
        }
    }
    let drained = timeout(Duration::from_millis(ctx.cfg.drain_max_ms.max(1)), async {
        let _ = sem
            .acquire_many(ctx.cfg.max_inflight as u32)
            .await
            .expect("semaphore closed");
    })
    .await;
    if drained.is_err() {
        let inflight = ctx.cfg.max_inflight.saturating_sub(sem.available_permits());
        tracing::warn!(
            inflight_batches = inflight as u64,
            drain_max_ms = ctx.cfg.drain_max_ms,
            "drain_timeout"
        );
    }
}

fn dispatch(ctx: &BatcherCtx, body: Bytes, entries: u64, permit: OwnedSemaphorePermit) {
    ctx.queue_len.fetch_sub(entries as usize, Ordering::Relaxed);
    ctx.notify.notify_waiters();
    tracing::debug!(entries, bytes = body.len(), "batch_dispatch");
    tokio::spawn(pusher::push(
        ctx.client.clone(),
        ctx.cfg.clone(),
        ctx.url.clone(),
        body,
        entries,
        ctx.stats.clone(),
        ctx.drain_deadline.clone(),
        permit,
    ));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    #[test]
    fn gzip_roundtrip_preserves_payload() {
        let input =
            br#"{"streams":[{"stream":{"level":"info"},"values":[["1","{\"msg\":\"x\"}"]]}]}"#;
        let compressed = compress_gzip(input);
        assert!(compressed.len() < input.len() * 2);
        let mut decoder = flate2::read::GzDecoder::new(compressed.as_slice());
        let mut out = Vec::new();
        decoder.read_to_end(&mut out).unwrap();
        assert_eq!(out, input);
    }
}
