import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'

const TICK_MS = 50

const file = process.argv[2]
const rate = Number.parseInt(process.argv[3], 10)

if (!file || !Number.isFinite(rate) || rate <= 0) {
  process.stderr.write(`${JSON.stringify({ event: 'usage', usage: 'node feed.mjs <file> <lines_per_sec>' })}\n`)
  process.exit(1)
}

process.stdout.on('error', (err) => {
  if (err.code === 'EPIPE') {
    process.exit(0)
  }
  process.stderr.write(`${JSON.stringify({ event: 'feed_error', message: err.message })}\n`)
  process.exit(1)
})

const perTick = Math.max(1, Math.round((rate * TICK_MS) / 1000))
const highWater = perTick * 8
const lowWater = perTick * 2

const input = createReadStream(file)
input.on('error', (err) => {
  process.stderr.write(`${JSON.stringify({ event: 'feed_error', file, message: err.message })}\n`)
  process.exit(1)
})

const rl = createInterface({ input, crlfDelay: Infinity })

const pending = []
let sourceDone = false

rl.on('line', (line) => {
  pending.push(line)
  if (pending.length >= highWater) rl.pause()
})

rl.on('close', () => {
  sourceDone = true
})

const startedAt = Date.now()
let sent = 0
let tick = 0

while (true) {
  const batch = pending.splice(0, perTick)
  if (batch.length > 0) {
    sent += batch.length
    if (!process.stdout.write(`${batch.join('\n')}\n`)) await once(process.stdout, 'drain')
  }
  if (!sourceDone && pending.length <= lowWater) rl.resume()
  if (sourceDone && pending.length === 0) break

  tick += 1
  const delay = startedAt + tick * TICK_MS - Date.now()
  await sleep(delay > 0 ? delay : 0)
}

const elapsedMs = Date.now() - startedAt
process.stderr.write(`${JSON.stringify({ event: 'fed', file, lines: sent, rate, elapsed_ms: elapsedMs, actual_lines_per_sec: elapsedMs > 0 ? Math.round((sent / elapsedMs) * 1000) : sent })}\n`)
