import { createWriteStream } from 'node:fs'
import { once } from 'node:events'

const BASE_TIME = 1754265600000
const CHUNK_LINES = 2000
const ERR_FRAGMENT = '"err":{"type":"Error","message":"boom","stack":"Error: boom\\n    at handler"},'

const lines = Number.parseInt(process.argv[2], 10)
const outFile = process.argv[3]

if (!Number.isFinite(lines) || lines <= 0 || !outFile) {
  process.stderr.write(`${JSON.stringify({ event: 'usage', usage: 'node gen-logs.mjs <lines> <outfile>' })}\n`)
  process.exit(1)
}

function buildLine (index) {
  const lineNo = index + 1
  const isError = lineNo % 100 === 0
  const isWarn = !isError && lineNo % 10 === 0
  const level = isError ? 50 : isWarn ? 40 : 30
  const responseTime = Math.floor(Math.random() * 251)
  const err = isError ? ERR_FRAGMENT : ''
  return `{"level":${level},"time":${BASE_TIME + index},"pid":4321,"hostname":"bench-host","reqId":"req-${index}","route":"/api/orders","responseTime":${responseTime},${err}"msg":"request completed"}\n`
}

const out = createWriteStream(outFile)
out.on('error', (err) => {
  process.stderr.write(`${JSON.stringify({ event: 'gen_error', file: outFile, message: err.message })}\n`)
  process.exit(1)
})

let bytes = 0
let buffer = ''

for (let i = 0; i < lines; i++) {
  buffer += buildLine(i)
  if ((i + 1) % CHUNK_LINES === 0) {
    bytes += Buffer.byteLength(buffer)
    if (!out.write(buffer)) await once(out, 'drain')
    buffer = ''
  }
}

if (buffer.length > 0) {
  bytes += Buffer.byteLength(buffer)
  if (!out.write(buffer)) await once(out, 'drain')
}

out.end()
await once(out, 'finish')

process.stdout.write(`${JSON.stringify({ event: 'generated', lines, bytes, file: outFile })}\n`)
