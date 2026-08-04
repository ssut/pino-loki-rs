#!/usr/bin/env node
import { createInterface } from 'node:readline'
import { writeFileSync } from 'node:fs'

let lines = 0
const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  if (line.length > 0) lines += 1
})
rl.on('close', () => {
  if (process.env.PLRS_TEST_OUT) {
    writeFileSync(process.env.PLRS_TEST_OUT, JSON.stringify({ lines }))
  }
})
