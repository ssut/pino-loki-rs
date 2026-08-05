import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'

import build from '../js/transport.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const stub = join(here, 'fixtures', 'stub-shipper.mjs')
const dying = join(here, 'fixtures', 'dying-shipper.mjs')

function readEvents (path) {
  if (!existsSync(path)) return []
  const raw = readFileSync(path, 'utf8').trim()
  if (raw.length === 0) return []
  return raw.split('\n').map((l) => JSON.parse(l))
}

async function waitForEvents (path, count, timeoutMs = 5000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (readEvents(path).length >= count) return readEvents(path)
    await delay(20)
  }
  throw new Error(`timeout waiting for ${count} events, got ${readEvents(path).length}`)
}

test('pipes every line to the child and closes only after child exit', async () => {
  const out = join(mkdtempSync(join(tmpdir(), 'plrs-')), 'count.json')
  process.env.PLRS_TEST_OUT = out
  try {
    const stream = build({ binPath: stub, host: 'http://127.0.0.1:1' })
    for (let i = 0; i < 1000; i += 1) {
      const flushed = stream.write(`{"level":30,"i":${i},"msg":"m"}\n`)
      if (!flushed) await once(stream, 'drain')
    }
    stream.end()
    await once(stream, 'close')
  } finally {
    delete process.env.PLRS_TEST_OUT
  }
  assert.deepStrictEqual(JSON.parse(readFileSync(out, 'utf8')), { lines: 1000 })
})

test('spawn failure destroys the stream with an error', async () => {
  const stream = build({ binPath: '/nonexistent/plrs-bin', host: 'http://127.0.0.1:1' })
  const [err] = await once(stream, 'error')
  assert.strictEqual(err instanceof Error, true)
})

test('respawns the child after an unexpected exit and keeps shipping', async () => {
  const out = join(mkdtempSync(join(tmpdir(), 'plrs-')), 'events.ndjson')
  writeFileSync(out, '')
  process.env.PLRS_TEST_OUT = out
  let events
  try {
    const stream = build({
      binPath: dying,
      host: 'http://127.0.0.1:1',
      respawnBaseMs: 20,
      silenceErrors: true
    })
    await waitForEvents(out, 1)
    stream.write('{"level":30,"msg":"before"}\n')
    stream.write('{"level":30,"msg":"die"}\n')
    await waitForEvents(out, 3)
    stream.write('{"level":30,"msg":"after"}\n')
    const closed = once(stream, 'close')
    stream.end()
    events = await waitForEvents(out, 4)
    await closed
  } finally {
    delete process.env.PLRS_TEST_OUT
  }
  assert.deepStrictEqual(
    events.map((e) => e.event),
    ['start', 'die', 'start', 'eof']
  )
  assert.notStrictEqual(events[2].pid, events[0].pid)
  assert.strictEqual(events[3].pid, events[2].pid)
  assert.strictEqual(events[1].lines, 2)
  assert.ok(events[3].lines >= 1, 'respawned child received the post-crash line')
})

test('writes are dropped without throwing once respawns are exhausted', async () => {
  const out = join(mkdtempSync(join(tmpdir(), 'plrs-')), 'events.ndjson')
  writeFileSync(out, '')
  process.env.PLRS_TEST_OUT = out
  try {
    const stream = build({
      binPath: dying,
      host: 'http://127.0.0.1:1',
      maxRespawns: 0,
      silenceErrors: true
    })
    await waitForEvents(out, 1)
    stream.write('{"level":30,"msg":"die"}\n')
    await waitForEvents(out, 2)
    await delay(150)
    for (let i = 0; i < 50; i += 1) {
      assert.strictEqual(stream.write(`{"level":30,"i":${i}}\n`), true)
    }
    const closed = once(stream, 'close')
    stream.end()
    await closed
  } finally {
    delete process.env.PLRS_TEST_OUT
  }
  assert.deepStrictEqual(
    readEvents(out).map((e) => e.event),
    ['start', 'die']
  )
})
