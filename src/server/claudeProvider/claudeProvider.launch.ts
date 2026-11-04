// Hands the provider env to a Claude agent PTY WITHOUT putting the key on any command line.
// Why a file: the tmux supervisor passes session env as `new-session -e K=V` argv (ptySupervisor.ts),
// readable in `ps` by every same-uid process. Instead the pane runs `/bin/sh <file>`: the 0600 file
// (in the 0700, sandbox-denied data dir) unsets/exports the variables, deletes itself, then execs the
// original command. Only the file PATH is ever in argv. The key ends up in the claude process env only.
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { shq } from '../hooksQuote'
import type { ProviderEnv } from './claudeProvider.model'
import { providerDir } from './claudeProvider.store'

const SAFE_NAME = /^[A-Z_][A-Z0-9_]*$/
/** A launch file the shell never consumed (spawn failed) is removed by the next launch after this age. */
export const STALE_LAUNCH_MS = 5 * 60_000

function sweepStale(dir: string, now: number): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    try { if (now - statSync(p).mtimeMs > STALE_LAUNCH_MS) unlinkSync(p) } catch { /* raced with its own rm: gone either way */ }
  }
}

/** POSIX sh body: unset, export, remove itself, exec `cmd` in the user's shell (non-login: the outer shell already was). */
export function launchScript(pe: ProviderEnv, shellBin: string, cmd: string): string {
  const names = [...pe.unset, ...Object.keys(pe.set)]
  if (names.some((n) => !SAFE_NAME.test(n))) throw new Error('claude provider: unsafe env name')
  return [
    ...(pe.unset.length ? [`unset ${pe.unset.join(' ')}`] : []),
    ...Object.entries(pe.set).map(([k, v]) => `export ${k}=${shq(v)}`),
    'rm -f -- "$0"',
    `exec ${shq(shellBin)} -c ${shq(cmd)}`,
    '',
  ].join('\n')
}

/**
 * `cmd` unchanged when the provider adds nothing (login mode); otherwise writes the one-shot script
 * and returns `/bin/sh '<file>'`. `dir` is injectable for tests.
 */
export function wrapClaudeLaunch(cmd: string, pe: ProviderEnv, shellBin: string, dir = join(providerDir(), 'launch'), now = Date.now()): string {
  if (Object.keys(pe.set).length === 0) return cmd
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  sweepStale(dir, now)
  const file = join(dir, `${randomBytes(12).toString('hex')}.sh`)
  try {
    writeFileSync(file, launchScript(pe, shellBin, cmd), { mode: 0o600, flag: 'wx' })
  } catch (err) {
    try { unlinkSync(file) } catch { /* never created */ }
    throw new Error(`claude provider: cannot write launch file (${(err as NodeJS.ErrnoException).code ?? 'error'})`)
  }
  return `/bin/sh ${shq(file)}`
}
