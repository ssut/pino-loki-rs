import { spawn } from 'node:child_process'
import { Writable } from 'node:stream'

import { resolveBinPath } from './resolve-bin.mjs'

const VALUE_FLAGS = [
  ['host', '--host'],
  ['intervalMs', '--interval-ms'],
  ['maxBatch', '--max-batch'],
  ['queueCap', '--queue-cap'],
  ['dropPolicy', '--drop-policy'],
  ['maxRetries', '--max-retries'],
  ['retryBaseMs', '--retry-base-ms'],
  ['retryMaxMs', '--retry-max-ms'],
  ['maxInflight', '--max-inflight'],
  ['timeoutMs', '--timeout-ms'],
  ['basicAuthUser', '--basic-auth-user'],
  ['basicAuthPassword', '--basic-auth-password'],
  ['structuredMetaKey', '--structured-meta-key'],
  ['tenant', '--tenant'],
  ['statsIntervalMs', '--stats-interval-ms'],
  ['drainMaxMs', '--drain-max-ms'],
  ['compression', '--compression']
]

const BOOL_FLAGS = [
  ['replaceTimestamp', '--replace-timestamp'],
  ['convertArrays', '--convert-arrays'],
  ['silenceErrors', '--silence-errors'],
  ['http2', '--http2']
]

function diag (payload) {
  try {
    process.stderr.write(`${JSON.stringify({ event: 'transport', src: 'pino-loki-rs/js', ...payload })}\n`)
  } catch {}
}

export function buildArgs (options) {
  const args = []
  for (const [key, flag] of VALUE_FLAGS) {
    const value = options[key]
    if (value === undefined || value === null || value === '') continue
    args.push(flag, String(value))
  }
  if (options.labels !== undefined && options.labels !== null) {
    const labels = typeof options.labels === 'string' ? options.labels : JSON.stringify(options.labels)
    if (labels.length > 0) args.push('--labels', labels)
  }
  if (options.propsToLabels !== undefined && options.propsToLabels !== null) {
    const csv = Array.isArray(options.propsToLabels)
      ? options.propsToLabels.join(',')
      : String(options.propsToLabels)
    if (csv.length > 0) args.push('--props-to-labels', csv)
  }
  if (options.headers && typeof options.headers === 'object' && !Array.isArray(options.headers)) {
    for (const [name, value] of Object.entries(options.headers)) {
      if (value === undefined || value === null) continue
      args.push('--header', `${name}=${value}`)
    }
  }
  for (const [key, flag] of BOOL_FLAGS) {
    if (options[key] === true) args.push(flag)
  }
  return args
}

function positive (value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

export default function pinoLokiRsTransport (options = {}) {
  const opts = options || {}
  if (!opts.host) throw new Error('pino-loki-rs transport: options.host is required')

  const binPath = opts.binPath || resolveBinPath()
  const args = buildArgs(opts)
  const maxRespawns = positive(opts.maxRespawns, 10)
  const respawnBaseMs = positive(opts.respawnBaseMs, 200)
  const respawnMaxMs = positive(opts.respawnMaxMs, 30000)

  let child = null
  let live = false
  let ending = false
  let closed = false
  let spawnFailed = false
  let respawns = 0
  let respawnTimer = null
  let droppedWhileDown = 0
  let pendingWriteCb = null
  let finalCb = null

  function onDrain () {
    releaseWrite(null)
  }

  function releaseWrite (err) {
    if (pendingWriteCb === null) return
    const cb = pendingWriteCb
    pendingWriteCb = null
    if (child && child.stdin) child.stdin.removeListener('drain', onDrain)
    cb(err || null)
  }

  function releaseFinal (err) {
    if (finalCb === null) return
    const cb = finalCb
    finalCb = null
    cb(err || null)
  }

  function cancelRespawn () {
    if (respawnTimer === null) return
    clearTimeout(respawnTimer)
    respawnTimer = null
  }

  function scheduleRespawn () {
    if (closed || ending || respawnTimer !== null) return
    if (respawns >= maxRespawns) {
      diag({ phase: 'respawn_exhausted', bin: binPath, attempts: respawns, dropped: droppedWhileDown })
      return
    }
    respawns += 1
    const delayMs = Math.min(respawnBaseMs * 2 ** (respawns - 1), respawnMaxMs)
    if (!opts.silenceErrors) diag({ phase: 'respawn_scheduled', bin: binPath, attempt: respawns, delayMs })
    respawnTimer = setTimeout(() => {
      respawnTimer = null
      start()
    }, delayMs)
    if (typeof respawnTimer.unref === 'function') respawnTimer.unref()
  }

  function start () {
    if (closed || ending) return
    let proc
    try {
      proc = spawn(binPath, args, { stdio: ['pipe', 'inherit', 'inherit'] })
    } catch (err) {
      live = false
      diag({ phase: 'spawn', bin: binPath, message: err && err.message })
      scheduleRespawn()
      return
    }
    child = proc
    live = true
    if (respawns > 0) {
      diag({ phase: 'respawned', bin: binPath, attempt: respawns, dropped: droppedWhileDown })
    }

    proc.stdin.on('error', (err) => {
      if (proc !== child) return
      live = false
      const code = err && err.code
      if (code !== 'EPIPE' && code !== 'ERR_STREAM_DESTROYED' && !opts.silenceErrors) {
        diag({ phase: 'stdin', code: code || null, message: err && err.message })
      }
      releaseWrite(null)
    })

    proc.on('error', (err) => {
      if (proc !== child) return
      live = false
      diag({ phase: 'spawn', bin: binPath, message: err && err.message })
      releaseWrite(null)
      if (respawns === 0) {
        spawnFailed = true
        releaseFinal(null)
        if (!stream.destroyed) stream.destroy(err)
        return
      }
      scheduleRespawn()
    })

    proc.on('exit', (code, signal) => {
      if (proc !== child) return
      live = false
      if (code !== 0 && !opts.silenceErrors) {
        diag({ phase: 'exit', bin: binPath, code, signal: signal || null })
      }
      releaseWrite(null)
      if (ending || closed) {
        releaseFinal(null)
        return
      }
      scheduleRespawn()
    })
  }

  const stream = new Writable({
    decodeStrings: false,
    autoDestroy: true,
    write (chunk, encoding, callback) {
      if (closed || !live || !child || !child.stdin || child.stdin.destroyed) {
        droppedWhileDown += 1
        callback(null)
        return
      }
      let flushed = false
      try {
        flushed = child.stdin.write(chunk)
      } catch {
        droppedWhileDown += 1
        callback(null)
        return
      }
      if (flushed) {
        callback(null)
        return
      }
      pendingWriteCb = callback
      child.stdin.once('drain', onDrain)
    },
    final (callback) {
      ending = true
      cancelRespawn()
      finalCb = callback
      if (spawnFailed || child === null) {
        releaseFinal(null)
        return
      }
      try {
        child.stdin.end()
      } catch {}
      if (!live) releaseFinal(null)
    },
    destroy (err, callback) {
      closed = true
      cancelRespawn()
      if (child && child.stdin) child.stdin.removeListener('drain', onDrain)
      pendingWriteCb = null
      finalCb = null
      if (child && live) {
        try { child.stdin.destroy() } catch {}
        try { child.kill('SIGTERM') } catch {}
      }
      if (droppedWhileDown > 0 && !opts.silenceErrors) {
        diag({ phase: 'closed', bin: binPath, dropped: droppedWhileDown, respawns })
      }
      callback(err)
    }
  })

  start()

  return stream
}
