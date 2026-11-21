// Test isolation for BOTH runners: vitest `globalSetup` (vite.config.ts) and `bun test` preload
// (bunfig.toml). Importing it points WEBTERM_DATA_DIR (and, under Node, HOME) at a fresh temp dir,
// so no test ever reads or writes the user's ~/.webterm-server or ~/.claude.
//
// Top-level side effect on purpose: vitest runs this in the main process before forking workers,
// which inherit the env; bun runs a preload in the test process itself.
//
// HOME: Bun resolves os.homedir() once at startup and ignores a later `process.env.HOME` write
// (checked: `bun -e "process.env.HOME='/x'; os.homedir()"` keeps the real home). So under Bun the
// `test:bun` script starts the process with `HOME=$(mktemp -d)`; this file only seeds that temp
// home and removes it afterwards (only when it really lives under the temp dir).
// Exception: `*.real.bun.test.ts` (real headful Chrome) runs in a second `bun test` with the real
// HOME, because Chrome on macOS under a fresh HOME hangs on Page.navigate (checked: passes with the
// real HOME, times out with a temp one). It still gets a temp data dir and its own temp profile.
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

/** Env var carrying the per-run temp root. Tests read it by name: importing this file mints a new root. */
const TEST_ROOT_ENV = 'WEBTERM_TEST_ROOT'

/** A run killed before `cleanup` leaves its root behind; roots older than this are certainly dead runs. */
const STALE_ROOT_MS = 2 * 3600_000
const sysTmp = tmpdir()
for (const name of readdirSync(sysTmp)) {
  if (!name.startsWith('webterm-test-')) continue
  try { if (Date.now() - statSync(join(sysTmp, name)).mtimeMs > STALE_ROOT_MS) rmSync(join(sysTmp, name), { recursive: true, force: true }) } catch { /* raced with another run's cleanup */ }
}

const root = mkdtempSync(join(sysTmp, 'webterm-test-'))
process.env[TEST_ROOT_ENV] = root
// Every `mkdtemp(tmpdir())` in a test (hundreds, many never removed) lands inside the root, so one rmSync
// frees them all. Before this, a killed run left GBs in the system temp dir.
mkdirSync(join(root, 'tmp'), { recursive: true })
process.env.TMPDIR = join(root, 'tmp')
process.env.WEBTERM_DATA_DIR = join(root, 'data')

/** A typical home: tests assume ~/Documents exists (controlCwd) and a global identity for commits
 *  in throwaway repos. A file, not author env vars: env would beat the repo-local identities the
 *  server sets on purpose (memoryFileEnsure). */
function seedHome(home: string): void {
  mkdirSync(join(home, 'Documents'), { recursive: true })
  writeFileSync(join(home, '.gitconfig'), '[user]\n\tname = webterm-test\n\temail = webterm-test@example.invalid\n')
}

// Under Bun a HOME outside the temp dir means the script was bypassed (plain `bun test <file>`):
// that home is left alone; WEBTERM_DATA_DIR still isolates the data dir.
const bunTempHome = process.versions.bun && homedir().startsWith(tmpdir() + '/') ? homedir() : null
if (!process.versions.bun) {
  process.env.HOME = join(root, 'home')
  seedHome(process.env.HOME)
} else if (bunTempHome) {
  seedHome(bunTempHome)
}

const cleanup = (): void => {
  rmSync(root, { recursive: true, force: true })
  if (bunTempHome) rmSync(bunTempHome, { recursive: true, force: true })
}
// `bun test` does not emit process 'exit' reliably (roots were left behind); a preload's
// `afterAll` is global and runs once after the last file.
if (process.versions.bun) (await import('bun:test')).afterAll(cleanup)

/** vitest globalSetup: the returned function is its teardown. */
export default function setup(): () => void {
  return cleanup
}
