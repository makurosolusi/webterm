import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isSafeWorkspaceId, profileDir, vaultDir, vaultFile, workspaceIdFromVaultName } from './profile.paths'

const BASE = '/tmp/st/webterm-data' // test-only

describe('profile.paths', () => {
  it('builds paths under the data dir', () => {
    expect(profileDir('ws_1', BASE)).toBe(join(BASE, 'browser', 'profiles', 'ws_1'))
    expect(vaultFile('ws_1', BASE)).toBe(join(vaultDir(BASE), 'ws_1.enc'))
  })

  it('rejects traversal and unsafe workspace ids', () => {
    for (const bad of ['..', '../x', 'a/b', 'a\\b', '', '.hidden', '/abs', 'a\0b', 'x'.repeat(129)]) {
      expect(isSafeWorkspaceId(bad), bad).toBe(false)
      expect(() => profileDir(bad, BASE)).toThrow(/invalid workspace id/)
      expect(() => vaultFile(bad, BASE)).toThrow(/invalid workspace id/)
    }
    expect(isSafeWorkspaceId(42)).toBe(false)
  })

  it('maps vault file names back to ids only for valid blobs', () => {
    expect(workspaceIdFromVaultName('ws_1.enc')).toBe('ws_1')
    expect(workspaceIdFromVaultName('.ws_1.123.tmp')).toBeNull()
    expect(workspaceIdFromVaultName('..enc')).toBeNull()
    expect(workspaceIdFromVaultName('a.txt')).toBeNull()
  })
})
