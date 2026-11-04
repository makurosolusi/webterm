import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { dataDir } from './config'

// Proof for the vitest globalSetup: tests never see the user's real home or data dir.
describe('test isolation (vitest)', () => {
  const root = process.env.WEBTERM_TEST_ROOT // set by src/testIsolation.setup.ts (not imported: that would mint a new root)
  const realHome = userInfo().homedir // passwd entry, not $HOME

  it('runs with a per-run temp root', () => {
    expect(root).toBeTruthy()
    expect(root).not.toContain(realHome)
  })

  it('dataDir() lives under the temp root, not ~/.webterm-server', () => {
    expect(dataDir().startsWith(root!)).toBe(true)
    expect(dataDir()).not.toBe(join(realHome, '.webterm-server'))
  })

  it('HOME (so ~/.claude) is redirected under the temp root', () => {
    expect(homedir().startsWith(root!)).toBe(true)
    expect(join(homedir(), '.claude').startsWith(realHome + '/')).toBe(false)
  })
})
