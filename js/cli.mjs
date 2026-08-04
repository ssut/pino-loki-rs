#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { resolveBinPath } from './resolve-bin.mjs'

const child = spawn(resolveBinPath(), process.argv.slice(2), { stdio: 'inherit' })

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    try {
      child.kill(signal)
    } catch {}
  })
}

child.on('exit', (code, signal) => {
  process.exit(signal ? 1 : code ?? 1)
})

child.on('error', (err) => {
  process.stderr.write(`${JSON.stringify({ event: 'spawn_error', bin: 'pino-loki-rs', message: err.message })}\n`)
  process.exit(1)
})
