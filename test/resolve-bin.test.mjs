import test from 'node:test'
import assert from 'node:assert/strict'

import { platformPackageName, resolveBinPath } from '../js/resolve-bin.mjs'

test('platform package name matches the running platform', () => {
  const name = platformPackageName()
  assert.strictEqual(name.startsWith(`pino-loki-rs-${process.platform}-${process.arch}`), true)
  if (process.platform === 'linux') {
    assert.strictEqual(/-(gnu|musl)$/.test(name), true)
  } else {
    assert.strictEqual(name, `pino-loki-rs-${process.platform}-${process.arch}`)
  }
})

test('PINO_LOKI_BIN overrides package resolution', () => {
  process.env.PINO_LOKI_BIN = '/tmp/plrs-fake-bin'
  try {
    assert.strictEqual(resolveBinPath(), '/tmp/plrs-fake-bin')
  } finally {
    delete process.env.PINO_LOKI_BIN
  }
})

test('missing platform package throws with guidance', (t) => {
  delete process.env.PINO_LOKI_BIN
  let resolved = null
  try {
    resolved = resolveBinPath()
  } catch (err) {
    assert.match(err.message, /PINO_LOKI_BIN/)
    return
  }
  t.skip(`platform package installed at ${resolved}`)
})
