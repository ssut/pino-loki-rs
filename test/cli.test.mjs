import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { once } from 'node:events'

const here = dirname(fileURLToPath(import.meta.url))
const cli = join(here, '..', 'js', 'cli.mjs')
const stub = join(here, 'fixtures', 'stub-shipper.mjs')

test('cli resolves via PINO_LOKI_BIN and forwards stdin', async () => {
  const out = join(mkdtempSync(join(tmpdir(), 'plrs-cli-')), 'count.json')
  const child = spawn(process.execPath, [cli, '--host', 'http://127.0.0.1:1'], {
    env: { ...process.env, PINO_LOKI_BIN: stub, PLRS_TEST_OUT: out },
    stdio: ['pipe', 'ignore', 'ignore']
  })
  for (let i = 0; i < 50; i += 1) {
    child.stdin.write(`{"level":30,"i":${i}}\n`)
  }
  child.stdin.end()
  const [code] = await once(child, 'exit')
  assert.strictEqual(code, 0)
  assert.deepStrictEqual(JSON.parse(readFileSync(out, 'utf8')), { lines: 50 })
})
