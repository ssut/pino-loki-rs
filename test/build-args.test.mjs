import test from 'node:test'
import assert from 'node:assert/strict'

import { buildArgs } from '../js/transport.mjs'

test('maps value flags, labels, props, headers and bools in order', () => {
  const args = buildArgs({
    host: 'http://127.0.0.1:3100',
    intervalMs: 500,
    tenant: 't1',
    compression: 'gzip',
    labels: { app: 'x' },
    propsToLabels: ['reqId', 'route'],
    headers: { 'X-A': '1', 'X-B': 'two' },
    silenceErrors: true,
    http2: true
  })
  assert.deepStrictEqual(args, [
    '--host', 'http://127.0.0.1:3100',
    '--interval-ms', '500',
    '--tenant', 't1',
    '--compression', 'gzip',
    '--labels', '{"app":"x"}',
    '--props-to-labels', 'reqId,route',
    '--header', 'X-A=1',
    '--header', 'X-B=two',
    '--silence-errors',
    '--http2'
  ])
})

test('skips undefined, null and empty values', () => {
  const args = buildArgs({
    host: 'http://h',
    tenant: undefined,
    basicAuthUser: null,
    structuredMetaKey: '',
    labels: null,
    propsToLabels: [],
    headers: { skip: null, keep: 0 },
    replaceTimestamp: false
  })
  assert.deepStrictEqual(args, ['--host', 'http://h', '--header', 'keep=0'])
})

test('accepts labels and props as preformatted strings', () => {
  const args = buildArgs({
    host: 'http://h',
    labels: '{"env":"prod"}',
    propsToLabels: 'reqId,level'
  })
  assert.deepStrictEqual(args, [
    '--host', 'http://h',
    '--labels', '{"env":"prod"}',
    '--props-to-labels', 'reqId,level'
  ])
})
