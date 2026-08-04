import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

function isMusl () {
  if (process.platform !== 'linux') return false
  try {
    const report = process.report.getReport()
    return !report.header.glibcVersionRuntime
  } catch {
    return true
  }
}

export function platformPackageName () {
  const libc = process.platform === 'linux' ? (isMusl() ? '-musl' : '-gnu') : ''
  return `pino-loki-rs-${process.platform}-${process.arch}${libc}`
}

export function resolveBinPath () {
  if (process.env.PINO_LOKI_BIN) return process.env.PINO_LOKI_BIN
  const pkg = platformPackageName()
  try {
    return require.resolve(`${pkg}/pino-loki-rs`)
  } catch {
    throw new Error(
      `pino-loki-rs: no prebuilt binary for ${process.platform}-${process.arch}. Install ${pkg}, set options.binPath, or set PINO_LOKI_BIN`
    )
  }
}
