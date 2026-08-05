#!/usr/bin/env node
import { createInterface } from 'node:readline'
import { appendFileSync } from 'node:fs'

const out = process.env.PLRS_TEST_OUT
let lines = 0

function record (event) {
  if (!out) return
  try {
    appendFileSync(out, `${JSON.stringify({ pid: process.pid, lines, event })}\n`)
  } catch {}
}

record('start')

const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  if (line.length === 0) return
  lines += 1
  if (line.includes('"die"')) {
    record('die')
    process.exit(7)
  }
})
rl.on('close', () => {
  record('eof')
})
