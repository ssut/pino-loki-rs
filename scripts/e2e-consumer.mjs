import pino from 'pino'

const transport = pino.transport({
  target: 'pino-loki-rs/transport',
  options: {
    host: 'http://127.0.0.1:3184',
    intervalMs: 200,
    labels: { app: 'e2e' }
  }
})

const logger = pino(transport)
for (let i = 0; i < 1000; i += 1) {
  logger.info({ i }, 'e2e line')
}

setTimeout(() => {
  transport.end()
  transport.on('close', () => {
    process.stderr.write('{"event":"consumer_done","lines":1000}\n')
    process.exit(0)
  })
}, 800)
