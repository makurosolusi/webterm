// `bun test` preload (bunfig.toml): refuses a path-less or huge `bun test` unless the owner / CI
// opted in. process.argv holds only the test file under `bun test`, so the real command line is
// read from /proc (Linux) or `ps` (macOS). If it cannot be read the guard stays out of the way.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { bunTestArgs, decideBun } from './testGuard.decide'

function commandLine(): string[] | null {
  try {
    return readFileSync('/proc/self/cmdline', 'utf8').split('\0').filter(Boolean)
  } catch {
    // No /proc (macOS): fall through to ps.
  }
  const r = spawnSync('ps', ['-ww', '-o', 'args=', '-p', String(process.pid)], { encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim().split(/\s+/) : null
}

const cmd = commandLine()
const args = cmd ? bunTestArgs(cmd) : null
if (args) {
  const d = decideBun(args, process.env)
  if (!d.allow) {
    console.error(`\n${d.reason}\n`)
    process.exit(2)
  }
}
