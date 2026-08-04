import { spawn, execFile } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { setTimeout as sleep } from 'node:timers/promises'
import autocannon from 'autocannon'

const execFileAsync = promisify(execFile)

const BENCH_DIR = path.dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = path.resolve(BENCH_DIR, '..')
const MOCK_BIN = path.join(ROOT_DIR, 'target/release/mock-loki')
const RS_BIN = path.join(ROOT_DIR, 'target/release/pino-loki-rs')
const APP_PATH = path.join(BENCH_DIR, 'app.mjs')
const RESULTS_DIR = path.join(BENCH_DIR, 'results')

const DURATION = Number.parseInt(process.env.DURATION || '12', 10)
const CONNECTIONS = Number.parseInt(process.env.CONNECTIONS || '32', 10)
const RUNS = Number.parseInt(process.env.RUNS || '3', 10)
const MOCK_PORT = Number.parseInt(process.env.MOCK_PORT || '3100', 10)
const APP_PORT = Number.parseInt(process.env.APP_PORT || '3200', 10)
const MOCK_HOST = `http://127.0.0.1:${MOCK_PORT}`
const APP_URL = `http://127.0.0.1:${APP_PORT}/api/orders`

const TRANSPORTS = ['baseline', 'loki-js', 'loki-rs']
const SAMPLE_MS = 500
const STABLE_POLLS = 3
const STABLE_MAX_MS = 60000

let mockProc = null
let appProc = null

function log (payload) {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), ...payload })}\n`)
}

function median (values) {
  const sorted = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b)
  if (sorted.length === 0) return null
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function round (value, digits) {
  if (value === null || !Number.isFinite(value)) return null
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function isAlive (proc) {
  return Boolean(proc) && proc.exitCode === null && proc.signalCode === null
}

function killProc (proc, signal) {
  if (!isAlive(proc)) return
  try {
    proc.kill(signal || 'SIGKILL')
  } catch {}
}

function cleanup () {
  killProc(appProc, 'SIGKILL')
  killProc(mockProc, 'SIGKILL')
}

function forwardLines (stream, onLine) {
  let buffer = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk) => {
    buffer += chunk
    let idx = buffer.indexOf('\n')
    while (idx !== -1) {
      const line = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 1)
      if (line.length > 0) onLine(line)
      idx = buffer.indexOf('\n')
    }
  })
}

function waitForLine (stream, predicate, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanupWaiter()
      reject(new Error(`timeout waiting for ${label}`))
    }, timeoutMs)
    const onLine = (line) => {
      if (!predicate(line)) return
      cleanupWaiter()
      resolve(line)
    }
    function cleanupWaiter () {
      clearTimeout(timer)
      stream.off('bench-line', onLine)
    }
    stream.on('bench-line', onLine)
  })
}

function pipeWithEvents (proc, streamName, prefix) {
  const stream = proc[streamName]
  forwardLines(stream, (line) => {
    stream.emit('bench-line', line)
    process.stderr.write(`${prefix} ${line}\n`)
  })
  return stream
}

async function mockStats () {
  const res = await fetch(`${MOCK_HOST}/stats`)
  if (!res.ok) throw new Error(`mock /stats http ${res.status}`)
  return res.json()
}

async function mockReset () {
  const res = await fetch(`${MOCK_HOST}/reset`, { method: 'POST' })
  if (!res.ok && res.status !== 204) throw new Error(`mock /reset http ${res.status}`)
}

async function waitForMockHttp (timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await mockStats()
      return true
    } catch {
      await sleep(200)
    }
  }
  return false
}

async function ensureMock () {
  if (isAlive(mockProc)) return
  log({ event: 'mock_start', bin: MOCK_BIN, port: MOCK_PORT })
  mockProc = spawn(MOCK_BIN, ['--port', String(MOCK_PORT)], {
    cwd: BENCH_DIR,
    stdio: ['ignore', 'inherit', 'pipe']
  })
  mockProc.on('error', (err) => {
    log({ event: 'mock_spawn_error', message: err.message })
  })
  const stderr = pipeWithEvents(mockProc, 'stderr', '[mock]')
  try {
    await waitForLine(stderr, (l) => l.includes('"event":"mock_ready"'), 10000, 'mock_ready')
  } catch (err) {
    log({ event: 'mock_ready_line_missing', message: err.message })
  }
  const ok = await waitForMockHttp(10000)
  if (!ok) throw new Error('mock-loki did not become ready on /stats')
  log({ event: 'mock_ready', port: MOCK_PORT })
}

async function waitForAppHttp (timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(APP_URL)
      if (res.ok) {
        await res.text()
        return true
      }
    } catch {}
    await sleep(200)
  }
  return false
}

async function startApp (transport) {
  log({ event: 'app_start', transport })
  appProc = spawn(process.execPath, [APP_PATH], {
    cwd: BENCH_DIR,
    env: {
      ...process.env,
      TRANSPORT: transport,
      PORT: String(APP_PORT),
      MOCK_HOST,
      RS_BIN
    },
    stdio: ['ignore', 'inherit', 'pipe']
  })
  const stderr = pipeWithEvents(appProc, 'stderr', `[app:${transport}]`)
  await waitForLine(stderr, (l) => l.includes('"event":"app_ready"'), 30000, 'app_ready')
  const ok = await waitForAppHttp(15000)
  if (!ok) throw new Error(`app (${transport}) did not answer GET ${APP_URL}`)
  log({ event: 'app_ready', transport, pid: appProc.pid })
  return appProc
}

async function stopApp () {
  if (!isAlive(appProc)) {
    appProc = null
    return
  }
  const proc = appProc
  const exited = new Promise((resolve) => proc.once('exit', resolve))
  proc.kill('SIGTERM')
  const guard = sleep(20000, 'timeout', { ref: false })
  const outcome = await Promise.race([exited.then(() => 'exited'), guard])
  if (outcome === 'timeout') {
    log({ event: 'app_force_kill', pid: proc.pid })
    killProc(proc, 'SIGKILL')
    await exited
  }
  appProc = null
}

async function rssKb (pid) {
  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'rss=', '-p', String(pid)])
    const value = Number.parseInt(stdout.trim(), 10)
    return Number.isFinite(value) ? value : 0
  } catch {
    return 0
  }
}

async function childPids (pid) {
  try {
    const { stdout } = await execFileAsync('pgrep', ['-P', String(pid)])
    return stdout.trim().split('\n').filter(Boolean).map((v) => Number.parseInt(v, 10)).filter(Number.isFinite)
  } catch {
    return []
  }
}

function startSampler (pid, state) {
  let busy = false
  const timer = setInterval(async () => {
    if (busy) return
    busy = true
    try {
      const app = await rssKb(pid)
      if (app > state.max_app_rss_kb) state.max_app_rss_kb = app
      const kids = await childPids(pid)
      let total = 0
      for (const kid of kids) total += await rssKb(kid)
      if (total > state.max_child_rss_kb) state.max_child_rss_kb = total
    } catch {} finally {
      busy = false
    }
  }, SAMPLE_MS)
  return () => clearInterval(timer)
}

function runAutocannon () {
  return new Promise((resolve, reject) => {
    autocannon(
      { url: APP_URL, connections: CONNECTIONS, duration: DURATION },
      (err, result) => (err ? reject(err) : resolve(result))
    )
  })
}

async function pollUntilStable () {
  const startedAt = Date.now()
  let lastEntries = -1
  let stableSince = startedAt
  let stableCount = 0
  let entries = 0
  while (Date.now() - startedAt < STABLE_MAX_MS) {
    try {
      const stats = await mockStats()
      entries = stats.entries
    } catch (err) {
      log({ event: 'stats_poll_error', message: err.message })
    }
    if (entries === lastEntries) {
      stableCount += 1
      if (stableCount >= STABLE_POLLS) break
    } else {
      lastEntries = entries
      stableCount = 1
      stableSince = Date.now()
    }
    await sleep(1000)
  }
  return { entries, drain_seconds: round((stableSince - startedAt) / 1000, 2) }
}

async function runOnce (transport, run) {
  await ensureMock()
  await mockReset()
  await startApp(transport)

  const state = { max_app_rss_kb: 0, max_child_rss_kb: 0 }
  const stopSampler = startSampler(appProc.pid, state)

  log({ event: 'load_start', transport, run, connections: CONNECTIONS, duration: DURATION })
  let result
  try {
    result = await runAutocannon()
  } finally {
    stopSampler()
  }

  const expectedLines = result.requests.total * 3
  let deliveredAtStop = null
  let deliveredFinal = null
  let drainSeconds = null

  if (transport === 'baseline') {
    await stopApp()
  } else {
    const atStop = await mockStats()
    deliveredAtStop = atStop.entries
    const stable = await pollUntilStable()
    deliveredFinal = stable.entries
    drainSeconds = stable.drain_seconds
    await stopApp()
  }

  const record = {
    transport,
    run,
    rps_avg: round(result.requests.average, 2),
    latency_p50: result.latency.p50,
    latency_p97_5: result.latency.p97_5,
    latency_p99: result.latency.p99,
    max_app_rss_kb: state.max_app_rss_kb,
    max_child_rss_kb: state.max_child_rss_kb,
    delivered_at_stop: deliveredAtStop,
    delivered_final: deliveredFinal,
    drain_seconds: drainSeconds,
    expected_lines: expectedLines,
    requests_total: result.requests.total,
    non2xx: result.non2xx,
    errors: result.errors,
    timeouts: result.timeouts
  }
  log({ event: 'run_done', ...record })
  return record
}

function summarize (rows) {
  const summary = {}
  for (const transport of TRANSPORTS) {
    const runs = rows.filter((r) => r.transport === transport)
    if (runs.length === 0) continue
    const expected = median(runs.map((r) => r.expected_lines))
    const delivered = median(runs.map((r) => r.delivered_final))
    summary[transport] = {
      runs: runs.length,
      rps_avg: median(runs.map((r) => r.rps_avg)),
      latency_p50: median(runs.map((r) => r.latency_p50)),
      latency_p97_5: median(runs.map((r) => r.latency_p97_5)),
      latency_p99: median(runs.map((r) => r.latency_p99)),
      max_app_rss_kb: median(runs.map((r) => r.max_app_rss_kb)),
      max_child_rss_kb: median(runs.map((r) => r.max_child_rss_kb)),
      delivered_at_stop: median(runs.map((r) => r.delivered_at_stop)),
      delivered_final: delivered,
      drain_seconds: median(runs.map((r) => r.drain_seconds)),
      expected_lines: expected,
      delivered_pct: expected && delivered !== null ? round((delivered / expected) * 100, 2) : null
    }
  }
  return summary
}

function printSummary (payload) {
  const base = payload.summary.baseline
  process.stdout.write('\n=== app impact (medians) ===\n')
  for (const transport of TRANSPORTS) {
    const s = payload.summary[transport]
    if (!s) continue
    const rpsDelta = base && base.rps_avg && transport !== 'baseline'
      ? ` (${round(((s.rps_avg - base.rps_avg) / base.rps_avg) * 100, 2)}% vs baseline)`
      : ''
    process.stdout.write(`- ${transport}\n`)
    process.stdout.write(`  - rps_avg: ${s.rps_avg}${rpsDelta}\n`)
    process.stdout.write(`  - latency p50/p97.5/p99 ms: ${s.latency_p50} / ${s.latency_p97_5} / ${s.latency_p99}\n`)
    process.stdout.write(`  - max app rss: ${round(s.max_app_rss_kb / 1024, 1)} MB, max child rss: ${round(s.max_child_rss_kb / 1024, 1)} MB\n`)
    if (transport === 'baseline') {
      process.stdout.write('  - delivery: n/a (no loki transport)\n')
      continue
    }
    process.stdout.write(`  - delivered at stop / final / expected: ${s.delivered_at_stop} / ${s.delivered_final} / ${s.expected_lines} (${s.delivered_pct}%)\n`)
    process.stdout.write(`  - drain_seconds: ${s.drain_seconds}\n`)
  }
}

async function main () {
  mkdirSync(RESULTS_DIR, { recursive: true })
  log({ event: 'app_impact_start', duration: DURATION, connections: CONNECTIONS, runs: RUNS, transports: TRANSPORTS })

  const rows = []
  const failures = []
  for (const transport of TRANSPORTS) {
    for (let run = 1; run <= RUNS; run++) {
      try {
        rows.push(await runOnce(transport, run))
      } catch (err) {
        log({ event: 'run_failed', transport, run, message: err.message })
        failures.push({ transport, run, message: err.message })
        await stopApp()
      }
    }
  }

  const payload = {
    generated_at: new Date().toISOString(),
    config: { duration: DURATION, connections: CONNECTIONS, runs: RUNS, app_url: APP_URL, mock_host: MOCK_HOST },
    all_runs: rows,
    failures,
    summary: summarize(rows)
  }

  const outFile = path.join(RESULTS_DIR, 'app-impact.json')
  writeFileSync(outFile, `${JSON.stringify(payload, null, 2)}\n`)
  log({ event: 'app_impact_written', file: outFile, runs: rows.length, failures: failures.length })
  printSummary(payload)
}

process.on('exit', cleanup)
process.on('SIGINT', () => {
  cleanup()
  process.exit(130)
})
process.on('SIGTERM', () => {
  cleanup()
  process.exit(143)
})

try {
  await main()
} catch (err) {
  log({ event: 'app_impact_failed', message: err.message })
  cleanup()
  process.exitCode = 1
} finally {
  await stopApp()
  killProc(mockProc, 'SIGTERM')
}
