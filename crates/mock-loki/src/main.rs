use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::extract::{DefaultBodyLimit, State};
use axum::http::{HeaderMap, StatusCode, Version};
use std::io::Read;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use clap::Parser;
use serde_json::Value;

#[derive(Parser, Clone)]
#[command(name = "mock-loki", version)]
struct Opts {
    #[arg(long, default_value_t = 3100)]
    port: u16,
    #[arg(long, default_value_t = 0)]
    latency_ms: u64,
    #[arg(long, default_value_t = 0.0)]
    fail_rate: f64,
    #[arg(long, default_value_t = 429)]
    fail_status: u16,
    #[arg(long, default_value_t = 0)]
    retry_after_secs: u64,
}

#[derive(Default)]
struct Counters {
    requests: AtomicU64,
    requests_http2: AtomicU64,
    entries: AtomicU64,
    injected_failures: AtomicU64,
    bytes: AtomicU64,
    bytes_raw: AtomicU64,
}

struct AppState {
    counters: Counters,
    opts: Opts,
}

async fn push(
    State(state): State<Arc<AppState>>,
    version: Version,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    state.counters.requests.fetch_add(1, Ordering::Relaxed);
    if version == Version::HTTP_2 {
        state.counters.requests_http2.fetch_add(1, Ordering::Relaxed);
    }
    if state.opts.latency_ms > 0 {
        tokio::time::sleep(Duration::from_millis(state.opts.latency_ms)).await;
    }
    if state.opts.fail_rate > 0.0 && fastrand::f64() < state.opts.fail_rate {
        state.counters.injected_failures.fetch_add(1, Ordering::Relaxed);
        let mut builder = Response::builder().status(
            StatusCode::from_u16(state.opts.fail_status).unwrap_or(StatusCode::TOO_MANY_REQUESTS),
        );
        if state.opts.retry_after_secs > 0 {
            builder = builder.header("Retry-After", state.opts.retry_after_secs.to_string());
        }
        return builder
            .body(Body::from("injected failure"))
            .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response());
    }
    state.counters.bytes.fetch_add(body.len() as u64, Ordering::Relaxed);
    let gzipped = headers
        .get("content-encoding")
        .and_then(|v| v.to_str().ok())
        .map(|v| v.eq_ignore_ascii_case("gzip"))
        .unwrap_or(false);
    let raw: Vec<u8> = if gzipped {
        let mut decoder = flate2::read::GzDecoder::new(body.as_ref());
        let mut out = Vec::with_capacity(body.len() * 4);
        if decoder.read_to_end(&mut out).is_err() {
            return StatusCode::BAD_REQUEST.into_response();
        }
        out
    } else {
        body.to_vec()
    };
    state
        .counters
        .bytes_raw
        .fetch_add(raw.len() as u64, Ordering::Relaxed);
    state
        .counters
        .entries
        .fetch_add(count_entries(&raw), Ordering::Relaxed);
    StatusCode::NO_CONTENT.into_response()
}

fn count_entries(body: &[u8]) -> u64 {
    serde_json::from_slice::<Value>(body)
        .ok()
        .as_ref()
        .and_then(|v| v.get("streams"))
        .and_then(Value::as_array)
        .map(|streams| {
            streams
                .iter()
                .map(|s| {
                    s.get("values")
                        .and_then(Value::as_array)
                        .map(|a| a.len() as u64)
                        .unwrap_or(0)
                })
                .sum()
        })
        .unwrap_or(0)
}

async fn stats(State(state): State<Arc<AppState>>) -> Json<Value> {
    Json(serde_json::json!({
        "requests": state.counters.requests.load(Ordering::Relaxed),
        "requests_http2": state.counters.requests_http2.load(Ordering::Relaxed),
        "entries": state.counters.entries.load(Ordering::Relaxed),
        "injected_failures": state.counters.injected_failures.load(Ordering::Relaxed),
        "bytes": state.counters.bytes.load(Ordering::Relaxed),
        "bytes_raw": state.counters.bytes_raw.load(Ordering::Relaxed),
    }))
}

async fn reset(State(state): State<Arc<AppState>>) -> StatusCode {
    state.counters.requests.store(0, Ordering::Relaxed);
    state.counters.requests_http2.store(0, Ordering::Relaxed);
    state.counters.entries.store(0, Ordering::Relaxed);
    state.counters.injected_failures.store(0, Ordering::Relaxed);
    state.counters.bytes.store(0, Ordering::Relaxed);
    state.counters.bytes_raw.store(0, Ordering::Relaxed);
    StatusCode::NO_CONTENT
}

#[tokio::main]
async fn main() {
    let opts = Opts::parse();
    let port = opts.port;
    let state = Arc::new(AppState {
        counters: Counters::default(),
        opts,
    });
    let app = Router::new()
        .route("/loki/api/v1/push", post(push))
        .route("/stats", get(stats))
        .route("/reset", post(reset))
        .layer(DefaultBodyLimit::disable())
        .with_state(state);
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
        .await
        .expect("bind failed");
    eprintln!("{}", serde_json::json!({"event": "mock_ready", "port": port}));
    axum::serve(listener, app).await.expect("serve failed");
}
