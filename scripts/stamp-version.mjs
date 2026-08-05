import { readFileSync, writeFileSync, readdirSync } from 'node:fs'

const version = process.argv[2]
if (!version) {
  process.stderr.write('{"event":"stamp_error","message":"version argument required"}\n')
  process.exit(1)
}

const stamp = (path) => {
  const pkg = JSON.parse(readFileSync(path, 'utf8'))
  pkg.version = version
  if (pkg.optionalDependencies) {
    for (const name of Object.keys(pkg.optionalDependencies)) {
      pkg.optionalDependencies[name] = version
    }
  }
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`)
  process.stderr.write(`${JSON.stringify({ event: 'stamped', path, version })}\n`)
}

const stampCargo = (path) => {
  const src = readFileSync(path, 'utf8')
  const pattern = /^version = "[^"]*"$/m
  if (!pattern.test(src)) {
    process.stderr.write(`${JSON.stringify({ event: 'stamp_error', path, message: 'package version line not found' })}\n`)
    process.exit(1)
  }
  writeFileSync(path, src.replace(pattern, `version = "${version}"`))
  process.stderr.write(`${JSON.stringify({ event: 'stamped', path, version })}\n`)
}

stamp('package.json')
for (const dir of readdirSync('npm')) {
  stamp(`npm/${dir}/package.json`)
}
stampCargo('crates/pino-loki-rs/Cargo.toml')
