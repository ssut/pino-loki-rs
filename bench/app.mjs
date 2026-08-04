import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pino from 'pino'

const TRANSPORT = process.env.TRANSPORT || 'baseline'
const PORT = Number.parseInt(process.env.PORT || '3200', 10)
const MOCK_HOST = process.env.MOCK_HOST || 'http://127.0.0.1:3100'
const RS_BIN = process.env.RS_BIN || '/Users/suhunhan/dev/pino-loki-rs/target/release/pino-loki-rs'

const hereDir = path.dirname(fileURLToPath(import.meta.url))
const RS_TRANSPORT = path.resolve(hereDir, '../js/transport.mjs')

function buildTransport () {
  if (TRANSPORT === 'loki-js') {
    return pino.transport({
      target: 'pino-loki',
      options: { host: MOCK_HOST, batching: true, interval: 1, timeout: 30000 }
    })
  }
  if (TRANSPORT === 'loki-rs') {
    return pino.transport({
      target: RS_TRANSPORT,
      options: { binPath: RS_BIN, host: MOCK_HOST, intervalMs: 1000, maxBatch: 1000 }
    })
  }
  return pino.transport({
    target: 'pino/file',
    options: { destination: '/dev/null' }
  })
}

const transport = buildTransport()
const logger = pino(transport)

let counter = 0

const server = http.createServer((req, res) => {
  const reqId = ++counter
  const route = req.url
  logger.info({ reqId, route, step: 'start' }, 'req start')
  logger.info({ reqId, route, responseTime: Math.floor(Math.random() * 251) }, 'req done')
  logger.info({ reqId, route, step: 'audit' }, 'audit')
  res.writeHead(200, { 'content-type': 'text/plain' })
  res.end('ok')
})

server.keepAliveTimeout = 60000

server.on('error', (err) => {
  process.stderr.write(`${JSON.stringify({ event: 'app_error', transport: TRANSPORT, port: PORT, message: err.message })}\n`)
  process.exit(1)
})

server.listen(PORT, '127.0.0.1', () => {
  process.stderr.write(`${JSON.stringify({ event: 'app_ready', port: PORT, transport: TRANSPORT })}\n`)
})

let shuttingDown = false

function shutdown (signal) {
  if (shuttingDown) return
  shuttingDown = true
  process.stderr.write(`${JSON.stringify({ event: 'app_shutdown', signal, transport: TRANSPORT, requests: counter })}\n`)
  const hardExit = setTimeout(() => process.exit(0), 15000)
  transport.on('close', () => {
    clearTimeout(hardExit)
    process.exit(0)
  })
  server.close(() => {
    transport.end()
  })
  server.closeIdleConnections()
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
