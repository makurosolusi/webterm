import { describe, expect, it } from 'bun:test'
import { homedir, tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { dataDir } from './config'

// Proof for the bunfig.toml preload + the `test:bun` script (src/testIsolation.setup.ts).
// One bun process runs every file, and many files point WEBTERM_DATA_DIR at their own temp dir
// without restoring it, so "under the run root" only holds when this file runs alone; the
// guarantee that matters across the run is "never the user's real data dir".
describe('test isolation (bun)', () => {
  it('the preload ran and dataDir() is not ~/.webterm-server', () => {
    expect(process.env.WEBTERM_TEST_ROOT).toBeTruthy() // set by the preload (not imported: that mints a new root)
    expect(dataDir()).not.toBe(join(userInfo().homedir, '.webterm-server'))
    expect(dataDir().startsWith(userInfo().homedir + '/')).toBe(false)
  })

  // Only through `npm run test:bun`: HOME must be set before Bun starts (a plain `bun test` keeps it).
  // Registered conditionally: the ambient bun:test types (bun-test.d.ts) have no skipIf.
  if (process.env.npm_lifecycle_event !== 'test:bun') return
  it('test:bun runs with a temp HOME, so ~/.claude is not the real one', () => {
    // (userInfo().homedir follows HOME under Bun, so the temp-dir prefix is the proof.)
    expect(homedir().startsWith(tmpdir() + '/')).toBe(true)
    expect(homedir()).toContain('webterm-home.')
  })
})
