use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use bytes::Bytes;
use tokio::sync::OwnedSemaphorePermit;
use tokio::time::{sleep, Duration};

use crate::config::{Compression, Config};
use crate::stats::Stats;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum RetryDecision {
    Retry,
    Drop,
}

pub fn classify(status: u16) -> RetryDecision {
    if status == 429 || status >= 500 {
        RetryDecision::Retry
    } else {
        RetryDecision::Drop
    }
}

pub fn epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn past_drain_deadline(drain_deadline: &AtomicU64, delay: Duration) -> bool {
    let deadline = drain_deadline.load(Ordering::Relaxed);
    deadline != 0 && epoch_ms().saturating_add(delay.as_millis() as u64) > deadline
}

#[allow(clippy::too_many_arguments)]
pub async fn push(
    client: reqwest::Client,
    cfg: Arc<Config>,
    url: Arc<String>,
    body: Bytes,
    entries: u64,
    stats: Arc<Stats>,
    drain_deadline: Arc<AtomicU64>,
    _permit: OwnedSemaphorePermit,
) {
    let started = Instant::now();
    let mut attempt: u32 = 0;
    loop {
        let mut req = client
            .post(url.as_str())
            .header("Content-Type", "application/json")
            .body(body.clone());
        if matches!(cfg.compression, Compression::Gzip) {
            req = req.header("Content-Encoding", "gzip");
        }
        if let (Some(u), Some(p)) = (&cfg.basic_auth_user, &cfg.basic_auth_password) {
            req = req.basic_auth(u, Some(p));
        }
        match req.send().await {
            Ok(resp) if resp.status().is_success() => {
                stats.batches_sent.fetch_add(1, Ordering::Relaxed);
                stats.entries_delivered.fetch_add(entries, Ordering::Relaxed);
                tracing::debug!(
                    entries,
                    attempt,
                    elapsed_ms = started.elapsed().as_millis() as u64,
                    "batch_delivered"
                );
                return;
            }
            Ok(resp) => {
                let status = resp.status().as_u16();
                let retry_after = resp
                    .headers()
                    .get("retry-after")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|s| s.parse::<u64>().ok());
                let body_text = resp.text().await.unwrap_or_default();
                if classify(status) == RetryDecision::Drop || attempt >= cfg.max_retries {
                    drop_batch(
                        &cfg,
                        &stats,
                        entries,
                        attempt,
                        &format!(
                            "status {status}: {}",
                            body_text.chars().take(200).collect::<String>()
                        ),
                    );
                    return;
                }
                attempt += 1;
                let delay = backoff_delay(attempt, retry_after, cfg.retry_base_ms, cfg.retry_max_ms);
                if past_drain_deadline(&drain_deadline, delay) {
                    drop_batch(&cfg, &stats, entries, attempt, "drain_deadline_exceeded");
                    return;
                }
                stats.retries.fetch_add(1, Ordering::Relaxed);
                if !cfg.silence_errors {
                    tracing::warn!(
                        status,
                        attempt,
                        entries,
                        delay_ms = delay.as_millis() as u64,
                        "push_retry"
                    );
                }
                sleep(delay).await;
            }
            Err(e) => {
                if attempt >= cfg.max_retries {
                    drop_batch(&cfg, &stats, entries, attempt, &e.to_string());
                    return;
                }
                attempt += 1;
                let delay = backoff_delay(attempt, None, cfg.retry_base_ms, cfg.retry_max_ms);
                if past_drain_deadline(&drain_deadline, delay) {
                    drop_batch(&cfg, &stats, entries, attempt, "drain_deadline_exceeded");
                    return;
                }
                stats.retries.fetch_add(1, Ordering::Relaxed);
                if !cfg.silence_errors {
                    tracing::warn!(
                        error = %e,
                        attempt,
                        entries,
                        delay_ms = delay.as_millis() as u64,
                        "push_retry"
                    );
                }
                sleep(delay).await;
            }
        }
    }
}

fn drop_batch(cfg: &Config, stats: &Stats, entries: u64, attempt: u32, reason: &str) {
    stats.batches_dropped_delivery.fetch_add(1, Ordering::Relaxed);
    stats
        .entries_dropped_delivery
        .fetch_add(entries, Ordering::Relaxed);
    if !cfg.silence_errors {
        tracing::error!(entries, attempt, reason, "batch_dropped");
    }
}

pub fn backoff_delay(
    attempt: u32,
    retry_after_secs: Option<u64>,
    base_ms: u64,
    max_ms: u64,
) -> Duration {
    if let Some(secs) = retry_after_secs {
        return Duration::from_millis(secs.saturating_mul(1000).clamp(base_ms, max_ms.max(base_ms)));
    }
    let shift = attempt.min(16);
    let exp = base_ms.saturating_mul(1u64 << shift);
    let jitter = fastrand::u64(0..=base_ms.max(1));
    Duration::from_millis(exp.min(max_ms).saturating_add(jitter))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_retries_429_and_5xx() {
        assert_eq!(classify(429), RetryDecision::Retry);
        assert_eq!(classify(500), RetryDecision::Retry);
        assert_eq!(classify(503), RetryDecision::Retry);
    }

    #[test]
    fn classify_drops_other_4xx() {
        assert_eq!(classify(400), RetryDecision::Drop);
        assert_eq!(classify(401), RetryDecision::Drop);
        assert_eq!(classify(413), RetryDecision::Drop);
    }

    #[test]
    fn backoff_honors_retry_after_within_bounds() {
        assert_eq!(
            backoff_delay(1, Some(1), 100, 5000),
            Duration::from_millis(1000)
        );
        assert_eq!(
            backoff_delay(1, Some(60), 100, 5000),
            Duration::from_millis(5000)
        );
        assert_eq!(
            backoff_delay(1, Some(0), 100, 5000),
            Duration::from_millis(100)
        );
    }

    #[test]
    fn backoff_grows_exponentially_with_jitter() {
        for _ in 0..50 {
            let d = backoff_delay(1, None, 100, 5000).as_millis() as u64;
            assert!((200..=300).contains(&d));
        }
        for _ in 0..50 {
            let d = backoff_delay(2, None, 100, 5000).as_millis() as u64;
            assert!((400..=500).contains(&d));
        }
    }

    #[test]
    fn backoff_caps_at_max() {
        for _ in 0..50 {
            let d = backoff_delay(12, None, 100, 5000).as_millis() as u64;
            assert!((5000..=5100).contains(&d));
        }
    }

    #[test]
    fn drain_deadline_zero_never_blocks() {
        let deadline = AtomicU64::new(0);
        assert!(!past_drain_deadline(&deadline, Duration::from_secs(3600)));
    }

    #[test]
    fn drain_deadline_in_past_blocks() {
        let deadline = AtomicU64::new(1);
        assert!(past_drain_deadline(&deadline, Duration::from_millis(10)));
    }
}
