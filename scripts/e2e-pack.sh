#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."

PKG_FULL=$(node --input-type=module -e "import('./js/resolve-bin.mjs').then((m) => console.log(m.platformPackageName()))")
PKG_DIR="npm/${PKG_FULL#pino-loki-rs-}"
echo "{\"event\":\"e2e_start\",\"platform_pkg\":\"$PKG_FULL\",\"dir\":\"$PKG_DIR\"}"

[ -x target/release/pino-loki-rs ] || cargo build --release -p pino-loki-rs
[ -x target/release/mock-loki ] || cargo build --release -p mock-loki
cp -f target/release/pino-loki-rs "$PKG_DIR/pino-loki-rs"
chmod +x "$PKG_DIR/pino-loki-rs"

WORK=$(mktemp -d)
cleanup() {
  lsof -ti:3184 2>/dev/null | xargs kill -9 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

(cd "$PKG_DIR" && pnpm pack --pack-destination "$WORK" > /dev/null)
pnpm pack --pack-destination "$WORK" > /dev/null
PLATFORM_TGZ=$(ls "$WORK"/pino-loki-rs-*-*.tgz | head -1)
MAIN_TGZ=$(ls "$WORK"/pino-loki-rs-[0-9]*.tgz | head -1)
echo "{\"event\":\"packed\",\"main\":\"$(basename "$MAIN_TGZ")\",\"platform\":\"$(basename "$PLATFORM_TGZ")\"}"

mkdir -p "$WORK/app"
printf '{"name":"plrs-e2e","private":true,"type":"module"}\n' > "$WORK/app/package.json"
(cd "$WORK/app" && pnpm add "$PLATFORM_TGZ" "$MAIN_TGZ" pino --config.optional=false --silent)
cp scripts/e2e-consumer.mjs "$WORK/app/consumer.mjs"

target/release/mock-loki --port 3184 2> "$WORK/mock.err" &
for i in $(seq 1 50); do
  curl -sf -o /dev/null http://127.0.0.1:3184/stats && break
  sleep 0.2
done

(cd "$WORK/app" && node consumer.mjs)
STATS=$(curl -s http://127.0.0.1:3184/stats)
echo "{\"event\":\"e2e_stats\",\"stats\":$STATS}"
ENTRIES=$(node --input-type=module -e "console.log(($STATS).entries)")
if [ "$ENTRIES" != "1000" ]; then
  echo "{\"event\":\"e2e_failed\",\"expected\":1000,\"got\":$ENTRIES}"
  exit 1
fi
echo '{"event":"e2e_ok","entries":1000}'
