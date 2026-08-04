#!/usr/bin/env bash
set -uo pipefail

BENCH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$BENCH_DIR" || exit 1

LINES="${LINES:-500000}"
RUNS="${RUNS:-3}"

MOCK_BIN="../target/release/mock-loki"
RS_BIN="../target/release/pino-loki-rs"
JS_CLI="node_modules/pino-loki/dist/cli.cjs"
MOCK_HOST="http://127.0.0.1:3100"
LOGS="tmp/logs.ndjson"
RUNS_FILE="tmp/throughput-runs.ndjson"
OUT_FILE="results/throughput.json"

MOCK_PID=""

cleanup() {
  if [ -n "$MOCK_PID" ]; then
    kill -9 "$MOCK_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

mkdir -p results tmp

echo "{\"event\":\"throughput_start\",\"lines\":$LINES,\"runs\":$RUNS}"

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

rm -f "$RUNS_FILE" tmp/mock.err

"$MOCK_BIN" --port 3100 2> tmp/mock.err &
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
echo "{\"event\":\"mock_ready\",\"pid\":$MOCK_PID}"

mock_entries() {
  local value
  value="$(curl -fsS "$MOCK_HOST/stats" 2>/dev/null | sed -n 's/.*"entries":[[:space:]]*\([0-9][0-9]*\).*/\1/p' | head -1)"
  if [ -z "$value" ]; then
    value=0
  fi
  echo "$value"
}

parse_time_file() {
  local file="$1"
  TIME_REAL="$(awk '{for(i=1;i<=NF;i++) if($i=="real"){print $(i-1); exit}}' "$file" 2>/dev/null)"
  TIME_USER="$(awk '{for(i=1;i<=NF;i++) if($i=="user"){print $(i-1); exit}}' "$file" 2>/dev/null)"
  TIME_SYS="$(awk '{for(i=1;i<=NF;i++) if($i=="sys"){print $(i-1); exit}}' "$file" 2>/dev/null)"
  TIME_RSS="$(awk '/maximum resident set size/{print $1; exit}' "$file" 2>/dev/null)"
  [ -n "$TIME_REAL" ] || TIME_REAL=0
  [ -n "$TIME_USER" ] || TIME_USER=0
  [ -n "$TIME_SYS" ] || TIME_SYS=0
  [ -n "$TIME_RSS" ] || TIME_RSS=0
}

for SHIPPER in js rs; do
  for RUN in $(seq 1 "$RUNS"); do
    curl -fsS -X POST "$MOCK_HOST/reset" > /dev/null 2>&1 || true
    ERR_FILE="tmp/${SHIPPER}-run${RUN}.err"
    TIME_FILE="tmp/${SHIPPER}-time${RUN}.txt"
    rm -f "$ERR_FILE" "$TIME_FILE"
    echo "{\"event\":\"run_start\",\"shipper\":\"$SHIPPER\",\"run\":$RUN}"

    if [ "$SHIPPER" = "js" ]; then
      /usr/bin/time -l sh -c "exec node $JS_CLI --hostname $MOCK_HOST -i 1 2>$ERR_FILE" < "$LOGS" 2> "$TIME_FILE"
    else
      /usr/bin/time -l sh -c "exec $RS_BIN --host $MOCK_HOST --interval-ms 1000 --max-batch 1000 2>$ERR_FILE" < "$LOGS" 2> "$TIME_FILE"
    fi
    EXIT_CODE=$?

    DELIVERED="$(mock_entries)"
    parse_time_file "$TIME_FILE"
    LPS="$(awk -v d="$DELIVERED" -v w="$TIME_REAL" 'BEGIN{ if (w+0>0) printf "%.2f", d/(w+0); else printf "0" }')"

    printf '{"shipper":"%s","run":%s,"exit_code":%s,"delivered":%s,"wall_s":%s,"user_s":%s,"sys_s":%s,"max_rss_bytes":%s,"lines_per_sec":%s}\n' \
      "$SHIPPER" "$RUN" "$EXIT_CODE" "$DELIVERED" "$TIME_REAL" "$TIME_USER" "$TIME_SYS" "$TIME_RSS" "$LPS" >> "$RUNS_FILE"

    echo "{\"event\":\"run_done\",\"shipper\":\"$SHIPPER\",\"run\":$RUN,\"exit_code\":$EXIT_CODE,\"delivered\":$DELIVERED,\"wall_s\":$TIME_REAL,\"lines_per_sec\":$LPS}"
  done
done

LINES="$LINES" RUNS="$RUNS" RUNS_FILE="$RUNS_FILE" OUT_FILE="$OUT_FILE" node --input-type=commonjs -e "$(cat <<'NODE'
const fs = require('node:fs')
const rows = fs.readFileSync(process.env.RUNS_FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const inputLines = Number(process.env.LINES)
const median = (values) => {
  const s = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
  if (s.length === 0) return null
  const m = Math.floor(s.length / 2)
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2
}
const round = (v, d) => (v === null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d)
const medians = {}
for (const shipper of ['js', 'rs']) {
  const r = rows.filter((x) => x.shipper === shipper)
  if (r.length === 0) continue
  const delivered = median(r.map((x) => x.delivered))
  const rss = median(r.map((x) => x.max_rss_bytes))
  medians[shipper] = {
    runs: r.length,
    delivered,
    loss_pct: inputLines > 0 && delivered !== null ? round(((inputLines - delivered) / inputLines) * 100, 3) : null,
    wall_s: median(r.map((x) => x.wall_s)),
    user_s: median(r.map((x) => x.user_s)),
    sys_s: median(r.map((x) => x.sys_s)),
    max_rss_bytes: rss,
    max_rss_mb: round(rss / (1024 * 1024), 1),
    lines_per_sec: median(r.map((x) => x.lines_per_sec))
  }
}
const payload = {
  generated_at: new Date().toISOString(),
  input_lines: inputLines,
  runs: Number(process.env.RUNS),
  all_runs: rows,
  medians
}
fs.writeFileSync(process.env.OUT_FILE, JSON.stringify(payload, null, 2) + '\n')
console.log('')
console.log('=== throughput medians (' + process.env.RUNS + ' runs x ' + inputLines + ' lines) ===')
for (const name of ['js', 'rs']) {
  const s = medians[name]
  if (!s) continue
  console.log('- ' + name)
  console.log('  - lines/sec: ' + s.lines_per_sec)
  console.log('  - wall: ' + s.wall_s + 's  user: ' + s.user_s + 's  sys: ' + s.sys_s + 's')
  console.log('  - max rss: ' + s.max_rss_mb + ' MB')
  console.log('  - delivered: ' + s.delivered + '/' + inputLines + '  (loss ' + s.loss_pct + '%)')
}
if (medians.js && medians.rs) {
  if (medians.js.lines_per_sec > 0) console.log('- speedup rs/js: ' + round(medians.rs.lines_per_sec / medians.js.lines_per_sec, 2) + 'x')
  if (medians.js.max_rss_bytes > 0) console.log('- rss ratio rs/js: ' + round(medians.rs.max_rss_bytes / medians.js.max_rss_bytes, 2) + 'x')
}
console.log('- results: ' + process.env.OUT_FILE)
NODE
)"
