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

export default function pinoLokiRsTransport (options = {}) {
  const opts = options || {}
  if (!opts.host) throw new Error('pino-loki-rs transport: options.host is required')

  const binPath = opts.binPath || resolveBinPath()
  const args = buildArgs(opts)
  const child = spawn(binPath, args, { stdio: ['pipe', 'inherit', 'inherit'] })

  let childExited = false
  let spawnFailed = false
  let pendingWriteCb = null
  let finalCb = null

  function onDrain () {
    releaseWrite(null)
  }

  function releaseWrite (err) {
    if (pendingWriteCb === null) return
    const cb = pendingWriteCb
    pendingWriteCb = null
    if (child.stdin) child.stdin.removeListener('drain', onDrain)
    cb(err || null)
  }

  function releaseFinal (err) {
    if (finalCb === null) return
    const cb = finalCb
    finalCb = null
    cb(err || null)
  }

  const stream = new Writable({
    decodeStrings: false,
    autoDestroy: true,
    write (chunk, encoding, callback) {
      if (childExited || spawnFailed) {
        callback(null)
        return
      }
      let flushed = false
      try {
        flushed = child.stdin.write(chunk)
      } catch (err) {
        callback(err)
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
      finalCb = callback
      if (spawnFailed) {
        releaseFinal(null)
        return
      }
      try {
        child.stdin.end()
      } catch {}
      if (childExited) releaseFinal(null)
    },
    destroy (err, callback) {
      if (child.stdin) child.stdin.removeListener('drain', onDrain)
      pendingWriteCb = null
      finalCb = null
      if (!childExited && !spawnFailed) {
        try { child.stdin.destroy() } catch {}
        try { child.kill('SIGTERM') } catch {}
      }
      callback(err)
    }
  })

  child.stdin.on('error', (err) => {
    const code = err && err.code
    if (code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED') {
      releaseWrite(null)
      releaseFinal(null)
      return
    }
    if (!opts.silenceErrors) diag({ phase: 'stdin', code: code || null, message: err && err.message })
    releaseWrite(null)
    releaseFinal(null)
    if (!stream.destroyed) stream.destroy(err)
  })

  child.on('error', (err) => {
    spawnFailed = true
    childExited = true
    diag({ phase: 'spawn', bin: binPath, message: err && err.message })
    releaseWrite(null)
    releaseFinal(null)
    if (!stream.destroyed) stream.destroy(err)
  })

  child.on('exit', (code, signal) => {
    childExited = true
    if (code !== 0 && !opts.silenceErrors) {
      diag({ phase: 'exit', bin: binPath, code, signal: signal || null })
    }
    releaseWrite(null)
    releaseFinal(null)
  })

  return stream
}
