use std::sync::atomic::AtomicU64;

#[derive(Default)]
pub struct Stats {
    pub read_lines: AtomicU64,
    pub parse_errors: AtomicU64,
    pub entries_dropped_queue: AtomicU64,
    pub batches_sent: AtomicU64,
    pub entries_delivered: AtomicU64,
    pub retries: AtomicU64,
    pub batches_dropped_delivery: AtomicU64,
    pub entries_dropped_delivery: AtomicU64,
}
