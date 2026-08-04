import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { once } from 'node:events'

import build from '../js/transport.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const stub = join(here, 'fixtures', 'stub-shipper.mjs')

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
