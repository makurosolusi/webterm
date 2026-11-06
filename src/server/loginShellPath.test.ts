// Lock for ops-212-4: a binary that only the login shell's PATH knows (Homebrew under launchd) is
// still found. A fake "login shell" script stands in for $SHELL; no rc file of the user is run.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { locateBinary, loginShellPath } from './loginShellPath'

const root = mkdtempSync(join(tmpdir(), 'wt-loginpath-'))
const brewBin = join(root, 'brew-bin')
const tool = join(brewBin, 'faketool')
const shell = join(root, 'fake-login-shell')
mkdirSync(brewBin)
writeFileSync(tool, '#!/bin/sh\n')
chmodSync(tool, 0o755)
// Prints a banner like a chatty rc file, sets PATH like a profile, then runs the `-c` command ($4).
writeFileSync(shell, `#!/bin/sh\necho "welcome banner"\nPATH="${brewBin}:/usr/bin:/bin"\nexport PATH\neval "$4"\n`)
chmodSync(shell, 0o755)

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('login shell PATH (ops-212-4)', () => {
  test('reads PATH from the login shell, ignoring whatever its rc files print', () => {
    expect(loginShellPath(shell, { PATH: '/usr/bin:/bin' })).toBe(`${brewBin}:/usr/bin:/bin`)
  })

  test('a binary missing from the process PATH is found on the login PATH, as an absolute path', () => {
    expect(locateBinary('faketool', '/usr/bin:/bin', () => loginShellPath(shell, { PATH: '/usr/bin:/bin' }))).toBe(tool)
  })

  test('a hit on the process PATH never runs the login shell', () => {
    let ran = 0
    expect(locateBinary('faketool', brewBin, () => { ran++; return undefined })).toBe(tool)
    expect(ran).toBe(0)
  })

  test('a failing login shell yields undefined, not a throw', () => {
    expect(loginShellPath(join(root, 'no-such-shell'), { PATH: '/usr/bin:/bin' })).toBeUndefined()
  })
})
