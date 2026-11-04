// Test isolation for BOTH runners: vitest `globalSetup` (vite.config.ts) and `bun test` preload
// (bunfig.toml). Importing it points WEBTERM_DATA_DIR (and, under Node, HOME) at a fresh temp dir,
// so no test ever reads or writes the user's ~/.webterm-server or ~/.claude.
//
// Top-level side effect on purpose: vitest runs this in the main process before forking workers,
// which inherit the env; bun runs a preload in the test process itself.
//
// HOME is Node-only: Bun resolves os.homedir() once at startup and ignores a later
// `process.env.HOME` write (checked: `bun -e "process.env.HOME='/x'; os.homedir()"` keeps the
// real home). Bun tests are covered by WEBTERM_DATA_DIR; redirecting HOME there needs `HOME=` in
// the `test:bun` script itself.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Env var carrying the per-run temp root. Tests read it by name: importing this file mints a new root. */
const TEST_ROOT_ENV = 'WEBTERM_TEST_ROOT'

const root = mkdtempSync(join(tmpdir(), 'webterm-test-'))
process.env[TEST_ROOT_ENV] = root
process.env.WEBTERM_DATA_DIR = join(root, 'data')
if (!process.versions.bun) {
  const home = join(root, 'home')
  process.env.HOME = home
  // A typical home: tests assume ~/Documents exists (controlCwd) and that git has a global identity
  // for commits in throwaway repos. A file, not GIT_AUTHOR_* env: env would beat repo-local
  // identities that the server sets on purpose (memoryFileEnsure).
  mkdirSync(join(home, 'Documents'), { recursive: true })
  writeFileSync(join(home, '.gitconfig'), '[user]\n\tname = webterm-test\n\temail = webterm-test@example.invalid\n')
}

const cleanup = (): void => rmSync(root, { recursive: true, force: true })
// `bun test` does not emit process 'exit' reliably (roots were left behind); a preload's
// `afterAll` is global and runs once after the last file.
if (process.versions.bun) (await import('bun:test')).afterAll(cleanup)

/** vitest globalSetup: the returned function is its teardown. */
export default function setup(): () => void {
  return cleanup
}
