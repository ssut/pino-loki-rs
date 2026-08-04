#!/bin/bash
set -uo pipefail
cd "$(dirname "$0")"
LINES="${LINES:-500000}"
RUNS="${RUNS:-3}"
RS_BIN=../target/release/pino-loki-rs
MOCK_BIN=../target/release/mock-loki
MOCK_HOST=http://127.0.0.1:3100
mkdir -p results tmp

cleanup() { lsof -ti:3100 2>/dev/null | xargs kill -9 2>/dev/null || true; }
trap cleanup EXIT
cleanup

if [ ! -f tmp/logs.ndjson ] || [ "$(wc -l < tmp/logs.ndjson | tr -d ' ')" != "$LINES" ]; then
  node gen-logs.mjs "$LINES" tmp/logs.ndjson
fi

RESULTS_TMP=tmp/h2-results.ndjson
rm -f "$RESULTS_TMP"

wait_mock() {
  for i in $(seq 1 50); do
    curl -s -o /dev/null "$MOCK_HOST/stats" && return 0
    sleep 0.2
  done
  echo '{"event":"mock_start_timeout"}'
  return 1
}

run_case() {
  scenario="$1"
  latency="$2"
  proto="$3"
  flag="$4"
  "$MOCK_BIN" --port 3100 --latency-ms "$latency" 2> "tmp/h2-mock-$scenario-$proto.err" &
  MOCK_PID=$!
  wait_mock || return 1
  for r in $(seq 1 "$RUNS"); do
    curl -s -X POST "$MOCK_HOST/reset" > /dev/null
    START=$(node -e 'console.log(Date.now())')
    $RS_BIN --host "$MOCK_HOST" --interval-ms 1000 --max-batch 1000 --stats-interval-ms 0 $flag < tmp/logs.ndjson 2> "tmp/h2-$scenario-$proto-run$r.err"
    END=$(node -e 'console.log(Date.now())')
    STATS=$(curl -s "$MOCK_HOST/stats")
    echo "{\"scenario\":\"$scenario\",\"proto\":\"$proto\",\"run\":$r,\"wall_ms\":$((END-START)),\"stats\":$STATS}" >> "$RESULTS_TMP"
    echo "{\"event\":\"run_done\",\"scenario\":\"$scenario\",\"proto\":\"$proto\",\"run\":$r,\"wall_ms\":$((END-START))}"
  done
  kill "$MOCK_PID" 2>/dev/null
  wait "$MOCK_PID" 2>/dev/null || true
  return 0
}

run_case fast 0 h1 ""
run_case fast 0 h2 "--http2"
run_case slow 100 h1 ""
run_case slow 100 h2 "--http2"

node --input-type=module - "$LINES" <<'EOF'
import { readFileSync, writeFileSync } from 'node:fs'
const lines = Number(process.argv[2])
const rows = readFileSync('tmp/h2-results.ndjson', 'utf8').trim().split('\n').map((l) => JSON.parse(l))
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] }
const cases = {}
for (const row of rows) {
  const key = `${row.scenario}-${row.proto}`
  cases[key] ||= { scenario: row.scenario, proto: row.proto, runs: [] }
  cases[key].runs.push({ wall_ms: row.wall_ms, entries: row.stats.entries, requests: row.stats.requests, requests_http2: row.stats.requests_http2 })
}
const summary = Object.values(cases).map((c) => {
  const wall = median(c.runs.map((r) => r.wall_ms))
  const entries = median(c.runs.map((r) => r.entries))
  const h2req = c.runs.reduce((a, r) => a + r.requests_http2, 0)
  const req = c.runs.reduce((a, r) => a + r.requests, 0)
  return {
    scenario: c.scenario,
    proto: c.proto,
    median_wall_ms: wall,
    median_lines_per_sec: Math.round(entries / (wall / 1000)),
    loss_pct: Number((100 * (1 - entries / lines)).toFixed(3)),
    protocol_verified: c.proto === 'h2' ? h2req === req && req > 0 : h2req === 0,
    runs: c.runs
  }
})
writeFileSync('results/h2.json', JSON.stringify({ input_lines: lines, summary }, null, 2))
for (const s of summary) console.log(JSON.stringify({ event: 'case_summary', ...s, runs: undefined }))
EOF

echo '{"event":"h2_bench_done","results":"results/h2.json"}'
