import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { controlCwdAllowed } from './controlCwd'

describe('controlCwdAllowed', () => {
  it('accepts a real directory under home', () => {
    expect(controlCwdAllowed(homedir())).toBe(true)
    expect(controlCwdAllowed(join(homedir(), 'Documents'))).toBe(true)
  })

  it('rejects relative, missing, and outside paths', () => {
    expect(controlCwdAllowed('relative/dir')).toBe(false)
    expect(controlCwdAllowed(join(homedir(), 'definitely-missing-xyz'))).toBe(false)
    expect(controlCwdAllowed('/')).toBe(false)
    expect(controlCwdAllowed('/etc')).toBe(false)
  })

  it('honours explicit extra roots and rejects a symlink escape', () => {
    const base = mkdtempSync(join(tmpdir(), 'webterm-cwd-'))
    const inside = mkdtempSync(join(base, 'inside-'))
    const link = join(base, 'escape')
    symlinkSync('/etc', link)
    try {
      expect(controlCwdAllowed(inside, base)).toBe(true)
      expect(controlCwdAllowed(inside)).toBe(false)
      expect(controlCwdAllowed(link, base)).toBe(false)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})
