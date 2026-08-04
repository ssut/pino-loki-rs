# pino-loki-rs

Rust rewrite of [pino-loki](https://github.com/Julien-R44/pino-loki): ships [pino](https://getpino.io) logs to [Grafana Loki](https://grafana.com/oss/loki/) from a separate process.

The Node side pipes raw NDJSON to a small Rust binary. Parsing, batching, retrying, and HTTP all happen outside your app's heap and event loop.

**2x the shipping throughput at 1/100th the memory, on the same CPU budget.** 0% log loss where the JS transport silently drops 20-30% under Loki backpressure. Optional gzip cuts wire bytes up to 13x at no measurable CPU cost. Receipts below.

## Numbers

Shipping 500k lines, medians of 3 (`bench/results/throughput.json`):

```
              pino-loki-rs   pino-loki 2.4.0
peak RSS      9.7 MB         1,030 MB
wall time     0.60 s         1.23 s
total CPU     1.21 s         1.24 s
user CPU      0.86 s         1.14 s
delivered     100%           100%
```

Same app under autocannon load, 3 log lines per request (`bench/results/app-impact.json`):

```
app peak RSS  160 MB + 8 MB child     1,086 MB (worker in-process)
app rps       no measurable difference either way
```

Loki injecting 20% HTTP 429 with 50 ms latency (`bench/results/durability.json`):

```
delivered     100,000 / 100,000       80,000 / 100,000
```

Loki slowed to 200 ms per push while 500k lines flood in at full speed, drop-oldest:

```
                  cap 20k, no compression   cap 200k, gzip
shipper peak RSS  40 MB                     30 MB
lines surviving   35,606 / 500,000          219,000 / 500,000
```

With `--compression gzip` the backlog is sealed into compressed blocks, so the same memory budget absorbs a ~6x larger burst — and the wire payload shrinks 13x (repetitive bench logs; expect 5-10x on real traffic) at no measurable CPU cost (total 1.39s vs 1.40s for 500k lines).

pino-loki has no retry path, so every 429'd batch is lost. Measured on an 18-core M-series MacBook against a localhost mock — relative numbers are the point, absolutes won't transfer.

## Features

- Bounded in-memory queue, so shipper RSS stays flat no matter how far Loki falls behind
- Queue-full behavior you pick: drop oldest, drop newest, or block
- Retries with exponential backoff and jitter, honors Retry-After
- At-most-once delivery where every drop moves a counter, never silent
- Batches capped by size and interval, grouped into streams by label set
- Bounded drain window on shutdown, sized to fit inside pino's 10s worker cap
- Signals are advisory: SIGTERM/SIGINT/SIGHUP keep intake open until stdin EOF, a repeated signal forces the bounded drain
- Optional gzip: bursts are sealed compressed in memory and pushed with Content-Encoding gzip
- Multi-tenant Loki via X-Scope-OrgID, custom headers, basic auth
- HTTP/1.1 and HTTP/2 (ALPN over TLS, `--http2` for prior-knowledge h2c)
- Every flag doubles as a `PINO_LOKI_*` env var for container deployments
- JSON diagnostics on stderr: periodic `stats_snapshot` plus a `final_stats` line at exit

## Usage

```bash
pnpm add pino-loki-rs
```

Prebuilt binaries install automatically for linux x64/arm64 (glibc and musl) and macos x64/arm64. Anything else: `cargo build --release`, then pass `binPath` or set `PINO_LOKI_BIN`.

```js
import pino from 'pino'

const logger = pino(pino.transport({
  target: 'pino-loki-rs/transport',
  options: {
    host: 'https://loki.example.com',
    tenant: 'my-tenant',
    labels: { app: 'my-service' }
  }
}))
```

Option names are the camelCase form of the CLI flags; `target` also accepts an absolute path to `js/transport.mjs` when vendoring.

Or skip the transport entirely and pipe:

```bash
node server.mjs | pino-loki-rs --host https://loki.example.com --labels '{"app":"my-service"}'
```

## Configuration

Flags win over env vars.

```
--host               PINO_LOKI_HOST               required
--tenant             PINO_LOKI_TENANT
--labels             PINO_LOKI_LABELS             JSON object
--props-to-labels    PINO_LOKI_PROPS_TO_LABELS    comma-separated, keep low-cardinality
--interval-ms        PINO_LOKI_INTERVAL_MS        1000
--max-batch          PINO_LOKI_MAX_BATCH          1000
--queue-cap          PINO_LOKI_QUEUE_CAP          100000
--drop-policy        PINO_LOKI_DROP_POLICY        oldest | newest | block
--max-retries        PINO_LOKI_MAX_RETRIES        3
--max-inflight       PINO_LOKI_MAX_INFLIGHT       4
--drain-max-ms       PINO_LOKI_DRAIN_MAX_MS       8000
--stats-interval-ms  PINO_LOKI_STATS_INTERVAL_MS  30000, 0 disables
--http2              PINO_LOKI_HTTP2              off
--compression        PINO_LOKI_COMPRESSION        none | gzip
```

Everything else: `pino-loki-rs --help`.

## Deploy

`examples/ecs/Dockerfile` is a two-stage linux/arm64 build (Fargate-ready), with a working integration in `examples/ecs/server.example.mjs`:

```bash
docker buildx build --platform linux/arm64 -f examples/ecs/Dockerfile -t my-service .
```

## Benchmarks

```bash
cargo build --release && (cd bench && npm install) && bash bench/run-all.sh
```

Three suites (throughput, durability, app impact) plus `bench/run-h2.sh` for the HTTP/1.1 vs HTTP/2 comparison (identical for this workload). Results land in `bench/results/*.json`.

While benchmarking we found that the upstream pino-loki 2.4.0 CLI silently drops 100% of logs on Node 18+ whenever `-t/--timeout` is passed (commander passes a string to `AbortSignal.timeout`). The suites avoid the flag, so the durability numbers above reflect genuine no-retry behavior, not that bug.

## License

Apache-2.0. Behavior-compatible rewrite of [pino-loki](https://github.com/Julien-R44/pino-loki) (MIT) by Julien Ripouteau — no affiliation.
