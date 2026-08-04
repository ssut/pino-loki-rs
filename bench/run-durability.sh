#!/usr/bin/env bash
set -uo pipefail

BENCH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$BENCH_DIR" || exit 1

LINES="${LINES:-100000}"
RATE="${RATE:-5000}"

MOCK_BIN="../target/release/mock-loki"
RS_BIN="../target/release/pino-loki-rs"
JS_CLI="node_modules/pino-loki/dist/cli.cjs"
MOCK_HOST="http://127.0.0.1:3100"
LOGS="tmp/logs-durability.ndjson"
OUT_FILE="results/durability.json"

MOCK_PID=""

cleanup() {
  if [ -n "$MOCK_PID" ]; then
    kill -9 "$MOCK_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

mkdir -p results tmp

echo "{\"event\":\"durability_start\",\"lines\":$LINES,\"rate\":$RATE}"

for BIN in "$MOCK_BIN" "$RS_BIN"; do
  if [ ! -x "$BIN" ]; then
    echo "{\"event\":\"missing_binary\",\"path\":\"$BIN\"}"
    exit 1
  fi
done

if [ ! -f "$JS_CLI" ]; then
  echo "{\"event\":\"missing_js_cli\",\"path\":\"$JS_CLI\"}"
  exit 1
fi

lsof -ti:3100 2>/dev/null | xargs kill -9 2>/dev/null || true
sleep 0.5

NEED_GEN=1
if [ -f "$LOGS" ]; then
  CUR_LINES="$(wc -l < "$LOGS" | tr -d ' ')"
  if [ "$CUR_LINES" = "$LINES" ]; then
    NEED_GEN=0
  fi
fi

if [ "$NEED_GEN" = "1" ]; then
  rm -f "$LOGS"
  node gen-logs.mjs "$LINES" "$LOGS" || exit 1
else
  echo "{\"event\":\"logs_reused\",\"file\":\"$LOGS\",\"lines\":$LINES}"
fi

rm -f tmp/mock-durability.err tmp/durability-js.err tmp/durability-rs.err

"$MOCK_BIN" --port 3100 --latency-ms 50 --fail-rate 0.2 --fail-status 429 --retry-after-secs 1 2> tmp/mock-durability.err &
MOCK_PID=$!

READY=0
for _ in $(seq 1 50); do
  if curl -fsS "$MOCK_HOST/stats" > /dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 0.2
done

if [ "$READY" != "1" ]; then
  echo "{\"event\":\"mock_not_ready\",\"host\":\"$MOCK_HOST\"}"
  exit 1
fi
echo "{\"event\":\"mock_ready\",\"pid\":$MOCK_PID,\"fail_rate\":0.2,\"fail_status\":429,\"latency_ms\":50}"

mock_entries() {
  local value
  value="$(curl -fsS "$MOCK_HOST/stats" 2>/dev/null | sed -n 's/.*"entries":[[:space:]]*\([0-9][0-9]*\).*/\1/p' | head -1)"
  if [ -z "$value" ]; then
    value=0
  fi
  echo "$value"
}

poll_until_stable() {
  local last=-1
  local stable=0
  local current=0
  local _i
  for _i in $(seq 1 60); do
    current="$(mock_entries)"
    if [ "$current" = "$last" ]; then
      stable=$((stable + 1))
      if [ "$stable" -ge 3 ]; then
        break
      fi
    else
      last="$current"
      stable=1
    fi
    sleep 1
  done
  STABLE_ENTRIES="$current"
}

curl -fsS -X POST "$MOCK_HOST/reset" > /dev/null 2>&1 || true
echo "{\"event\":\"shipper_start\",\"shipper\":\"js\"}"
node feed.mjs "$LOGS" "$RATE" | node "$JS_CLI" --hostname "$MOCK_HOST" -i 1 2> tmp/durability-js.err
poll_until_stable
JS_DELIVERED="$STABLE_ENTRIES"
JS_ERR_LINES="$(grep -c . tmp/durability-js.err 2>/dev/null || true)"
[ -n "$JS_ERR_LINES" ] || JS_ERR_LINES=0
echo "{\"event\":\"shipper_done\",\"shipper\":\"js\",\"delivered\":$JS_DELIVERED,\"stderr_error_lines\":$JS_ERR_LINES}"

curl -fsS -X POST "$MOCK_HOST/reset" > /dev/null 2>&1 || true
echo "{\"event\":\"shipper_start\",\"shipper\":\"rs\"}"
node feed.mjs "$LOGS" "$RATE" | "$RS_BIN" --host "$MOCK_HOST" --interval-ms 1000 --max-batch 1000 --max-retries 5 --retry-base-ms 100 --retry-max-ms 3000 2> tmp/durability-rs.err
poll_until_stable
RS_DELIVERED="$STABLE_ENTRIES"
RS_FINAL_STATS="$(grep '"event":"final_stats"' tmp/durability-rs.err 2>/dev/null | tail -1)"
echo "{\"event\":\"shipper_done\",\"shipper\":\"rs\",\"delivered\":$RS_DELIVERED}"

INPUT_LINES="$LINES" JS_DELIVERED="$JS_DELIVERED" JS_ERR_LINES="$JS_ERR_LINES" RS_DELIVERED="$RS_DELIVERED" RS_FINAL_STATS="$RS_FINAL_STATS" OUT_FILE="$OUT_FILE" node --input-type=commonjs -e "$(cat <<'NODE'
const fs = require('node:fs')
const input = Number(process.env.INPUT_LINES)
const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
const round = (v, d) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null)
const lossPct = (delivered) => (input > 0 ? round(((input - delivered) / input) * 100, 3) : null)
let finalStats = null
try {
  finalStats = JSON.parse(process.env.RS_FINAL_STATS || '')
} catch {
  finalStats = null
}
const jsDelivered = num(process.env.JS_DELIVERED)
const rsDelivered = num(process.env.RS_DELIVERED)
const payload = {
  generated_at: new Date().toISOString(),
  input_lines: input,
  js: {
    delivered: jsDelivered,
    loss_pct: lossPct(jsDelivered),
    stderr_error_lines: num(process.env.JS_ERR_LINES)
  },
  rs: {
    delivered: rsDelivered,
    loss_pct: lossPct(rsDelivered),
    final_stats: finalStats
  }
}
fs.writeFileSync(process.env.OUT_FILE, JSON.stringify(payload, null, 2) + '\n')
console.log('')
console.log('=== durability (latency 50ms, fail-rate 0.2, status 429, Retry-After 1s) ===')
console.log('- input lines: ' + input)
console.log('- js delivered: ' + payload.js.delivered + '  (loss ' + payload.js.loss_pct + '%)')
console.log('  - stderr error lines: ' + payload.js.stderr_error_lines)
console.log('- rs delivered: ' + payload.rs.delivered + '  (loss ' + payload.rs.loss_pct + '%)')
if (finalStats) {
  console.log('  - batches_sent: ' + finalStats.batches_sent + '  retries: ' + finalStats.retries)
  console.log('  - dropped queue/delivery: ' + finalStats.entries_dropped_queue + ' / ' + finalStats.entries_dropped_delivery)
  console.log('  - parse_errors: ' + finalStats.parse_errors + '  elapsed_ms: ' + finalStats.elapsed_ms)
} else {
  console.log('  - final_stats: not found in tmp/durability-rs.err')
}
console.log('- results: ' + process.env.OUT_FILE)
NODE
)"
