import { describe, expect, it } from 'bun:test'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { dataDir } from './config'

// Proof for the bunfig.toml preload. HOME is not redirected under Bun (see src/testIsolation.setup.ts).
// One bun process runs every file, and many files point WEBTERM_DATA_DIR at their own temp dir
// without restoring it, so "under the run root" only holds when this file runs alone; the
// guarantee that matters across the run is "never the user's real data dir".
describe('test isolation (bun)', () => {
  it('the preload ran and dataDir() is not ~/.webterm-server', () => {
    expect(process.env.WEBTERM_TEST_ROOT).toBeTruthy() // set by the preload (not imported: that mints a new root)
    expect(dataDir()).not.toBe(join(userInfo().homedir, '.webterm-server'))
    expect(dataDir().startsWith(userInfo().homedir + '/')).toBe(false)
  })
})
