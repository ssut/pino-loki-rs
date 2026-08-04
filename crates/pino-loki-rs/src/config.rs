use clap::{Parser, ValueEnum};

#[derive(Clone, Copy, PartialEq, Eq, Debug, ValueEnum)]
pub enum DropPolicy {
    Oldest,
    Newest,
    Block,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, ValueEnum)]
pub enum Compression {
    None,
    Gzip,
}

#[derive(Parser, Clone, Debug)]
#[command(name = "pino-loki-rs", version)]
pub struct Config {
    #[arg(long, env = "PINO_LOKI_HOST")]
    pub host: String,
    #[arg(long, env = "PINO_LOKI_INTERVAL_MS", default_value_t = 1000)]
    pub interval_ms: u64,
    #[arg(long, env = "PINO_LOKI_MAX_BATCH", default_value_t = 1000)]
    pub max_batch: usize,
    #[arg(long, env = "PINO_LOKI_QUEUE_CAP", default_value_t = 100_000)]
    pub queue_cap: usize,
    #[arg(long, env = "PINO_LOKI_DROP_POLICY", value_enum, default_value_t = DropPolicy::Oldest)]
    pub drop_policy: DropPolicy,
    #[arg(long, env = "PINO_LOKI_MAX_RETRIES", default_value_t = 3)]
    pub max_retries: u32,
    #[arg(long, env = "PINO_LOKI_RETRY_BASE_MS", default_value_t = 100)]
    pub retry_base_ms: u64,
    #[arg(long, env = "PINO_LOKI_RETRY_MAX_MS", default_value_t = 5000)]
    pub retry_max_ms: u64,
    #[arg(long, env = "PINO_LOKI_MAX_INFLIGHT", default_value_t = 4)]
    pub max_inflight: usize,
    #[arg(long, env = "PINO_LOKI_TIMEOUT_MS", default_value_t = 30_000)]
    pub timeout_ms: u64,
    #[arg(long, env = "PINO_LOKI_LABELS")]
    pub labels: Option<String>,
    #[arg(long, env = "PINO_LOKI_PROPS_TO_LABELS")]
    pub props_to_labels: Option<String>,
    #[arg(long, env = "PINO_LOKI_TENANT")]
    pub tenant: Option<String>,
    #[arg(long = "header", env = "PINO_LOKI_HEADERS", value_delimiter = ',')]
    pub headers: Vec<String>,
    #[arg(long, env = "PINO_LOKI_BASIC_AUTH_USER")]
    pub basic_auth_user: Option<String>,
    #[arg(long, env = "PINO_LOKI_BASIC_AUTH_PASSWORD")]
    pub basic_auth_password: Option<String>,
    #[arg(long, env = "PINO_LOKI_STATS_INTERVAL_MS", default_value_t = 30_000)]
    pub stats_interval_ms: u64,
    #[arg(long, env = "PINO_LOKI_DRAIN_MAX_MS", default_value_t = 8000)]
    pub drain_max_ms: u64,
    #[arg(long, env = "PINO_LOKI_REPLACE_TIMESTAMP", default_value_t = false)]
    pub replace_timestamp: bool,
    #[arg(long, env = "PINO_LOKI_CONVERT_ARRAYS", default_value_t = false)]
    pub convert_arrays: bool,
    #[arg(long, env = "PINO_LOKI_STRUCTURED_META_KEY")]
    pub structured_meta_key: Option<String>,
    #[arg(long, env = "PINO_LOKI_SILENCE_ERRORS", default_value_t = false)]
    pub silence_errors: bool,
    #[arg(long, env = "PINO_LOKI_HTTP2", default_value_t = false)]
    pub http2: bool,
    #[arg(long, env = "PINO_LOKI_COMPRESSION", value_enum, default_value_t = Compression::None)]
    pub compression: Compression,
}
