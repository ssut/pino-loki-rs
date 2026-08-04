#!/usr/bin/env bash
set -uo pipefail

BENCH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$BENCH_DIR" || exit 1

echo "=== [0/4] preflight ==="
[ -x ../target/release/pino-loki-rs ] || { echo "missing binary: ../target/release/pino-loki-rs"; exit 1; }
[ -x ../target/release/mock-loki ] || { echo "missing binary: ../target/release/mock-loki"; exit 1; }
echo "binaries ok"

if [ ! -d node_modules ]; then
  echo "installing bench deps"
  pnpm install || { echo "pnpm install failed"; exit 1; }
fi
echo "node_modules ok"

echo ""
echo "=== [1/4] throughput ==="
bash run-throughput.sh
THROUGHPUT_STATUS=$?

echo ""
echo "=== [2/4] durability ==="
bash run-durability.sh
DURABILITY_STATUS=$?

echo ""
echo "=== [3/4] app impact ==="
node run-app-impact.mjs
APP_IMPACT_STATUS=$?

echo ""
echo "=== [4/4] summary ==="
echo "{\"event\":\"suite_status\",\"throughput\":$THROUGHPUT_STATUS,\"durability\":$DURABILITY_STATUS,\"app_impact\":$APP_IMPACT_STATUS}"

node --input-type=commonjs -e "$(cat <<'NODE'
const fs = require('node:fs')
const read = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}
const round = (v, d) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null)

const throughput = read('results/throughput.json')
const durability = read('results/durability.json')
const appImpact = read('results/app-impact.json')

console.log('')
console.log('## throughput (results/throughput.json)')
if (!throughput) {
  console.log('- not available')
} else {
  console.log('- input lines: ' + throughput.input_lines + ', runs: ' + throughput.runs)
  for (const name of ['js', 'rs']) {
    const s = throughput.medians[name]
    if (!s) continue
    console.log('- ' + name + ': ' + s.lines_per_sec + ' lines/sec, wall ' + s.wall_s + 's, cpu ' + round(s.user_s + s.sys_s, 2) + 's, rss ' + s.max_rss_mb + ' MB, loss ' + s.loss_pct + '%')
  }
  const js = throughput.medians.js
  const rs = throughput.medians.rs
  if (js && rs && js.lines_per_sec > 0) console.log('- speedup rs/js: ' + round(rs.lines_per_sec / js.lines_per_sec, 2) + 'x')
}

console.log('')
console.log('## durability (results/durability.json)')
if (!durability) {
  console.log('- not available')
} else {
  console.log('- input lines: ' + durability.input_lines)
  console.log('- js: delivered ' + durability.js.delivered + ', loss ' + durability.js.loss_pct + '%, stderr error lines ' + durability.js.stderr_error_lines)
  console.log('- rs: delivered ' + durability.rs.delivered + ', loss ' + durability.rs.loss_pct + '%')
  const fs2 = durability.rs.final_stats
  if (fs2) console.log('- rs final_stats: retries ' + fs2.retries + ', batches_sent ' + fs2.batches_sent + ', dropped queue/delivery ' + fs2.entries_dropped_queue + '/' + fs2.entries_dropped_delivery)
}

console.log('')
console.log('## app impact (results/app-impact.json)')
if (!appImpact) {
  console.log('- not available')
} else {
  const base = appImpact.summary.baseline
  for (const name of ['baseline', 'loki-js', 'loki-rs']) {
    const s = appImpact.summary[name]
    if (!s) continue
    const delta = base && base.rps_avg && name !== 'baseline' ? ' (' + round(((s.rps_avg - base.rps_avg) / base.rps_avg) * 100, 2) + '% vs baseline)' : ''
    console.log('- ' + name + ': ' + s.rps_avg + ' rps' + delta + ', p99 ' + s.latency_p99 + 'ms, app rss ' + round(s.max_app_rss_kb / 1024, 1) + ' MB, child rss ' + round(s.max_child_rss_kb / 1024, 1) + ' MB')
    if (name !== 'baseline') console.log('  - delivered ' + s.delivered_final + '/' + s.expected_lines + ' (' + s.delivered_pct + '%), drain ' + s.drain_seconds + 's')
  }
  if (appImpact.failures && appImpact.failures.length > 0) console.log('- failures: ' + appImpact.failures.length)
}
NODE
)"
