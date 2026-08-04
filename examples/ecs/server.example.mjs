import http from 'node:http'
import { fileURLToPath } from 'node:url'
import pino from 'pino'

const PORT = Number.parseInt(process.env.PORT || '3000', 10)
const APP_NAME = process.env.APP_NAME || 'example-service'
const APP_ENV = process.env.APP_ENV || process.env.NODE_ENV || 'development'
const LOG_LEVEL = process.env.LOG_LEVEL || 'info'
const SHUTDOWN_MAX_MS = Number.parseInt(process.env.SHUTDOWN_MAX_MS || '15000', 10)

const LOKI_HOST = process.env.PINO_LOKI_HOST || 'https://loki.example.com'
const LOKI_TENANT = process.env.PINO_LOKI_TENANT || ''
const LOKI_BIN = process.env.PINO_LOKI_BIN || '/usr/local/bin/pino-loki-rs'

const TRANSPORT_TARGET =
  process.env.PINO_LOKI_TRANSPORT_TARGET ||
  fileURLToPath(new URL('../../js/transport.mjs', import.meta.url))

const transport = pino.transport({
  target: TRANSPORT_TARGET,
  options: {
    binPath: LOKI_BIN,
    host: LOKI_HOST,
    tenant: LOKI_TENANT || undefined,
    labels: { app: APP_NAME, env: APP_ENV },
    propsToLabels: ['level'],
    intervalMs: 1000,
    maxBatch: 1000,
    queueCap: 100000,
    dropPolicy: 'oldest',
    maxRetries: 3,
    retryBaseMs: 100,
    retryMaxMs: 5000,
    maxInflight: 4,
    timeoutMs: 30000,
    replaceTimestamp: true
  }
})

const logger = pino(
  {
    level: LOG_LEVEL,
    base: { app: APP_NAME, env: APP_ENV, pid: process.pid }
  },
  transport
)

let requestSeq = 0

const server = http.createServer((req, res) => {
  const requestId = `${process.pid}-${++requestSeq}`
  const startedAt = process.hrtime.bigint()
  const route = (req.url || '/').split('?')[0]

  logger.info(
    { event: 'request_start', requestId, method: req.method, route },
    'request start'
  )

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6
    logger.info(
      {
        event: 'request_finish',
        requestId,
        method: req.method,
        route,
        status: res.statusCode,
        durationMs: Math.round(durationMs * 1000) / 1000
      },
      'request finish'
    )
  })

  if (route === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
    return
  }

  logger.info(
    { event: 'request_audit', requestId, route, actor: req.headers['x-actor-id'] || null },
    'request audit'
  )

  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: true, requestId }))
})

server.keepAliveTimeout = 60000

server.on('error', (err) => {
  logger.error({ event: 'server_error', port: PORT, message: err.message }, 'server error')
  process.exit(1)
})

server.listen(PORT, () => {
  logger.info(
    { event: 'server_ready', port: PORT, lokiHost: LOKI_HOST, transportTarget: TRANSPORT_TARGET },
    'server ready'
  )
})

let shuttingDown = false

function shutdown (signal) {
  if (shuttingDown) return
  shuttingDown = true

  logger.info({ event: 'shutdown_start', signal, requests: requestSeq }, 'shutdown start')

  const hardExit = setTimeout(() => {
    process.exit(0)
  }, SHUTDOWN_MAX_MS)

  transport.on('close', () => {
    clearTimeout(hardExit)
    process.exit(0)
  })

  server.closeIdleConnections()
  server.close(() => {
    transport.end()
  })
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
