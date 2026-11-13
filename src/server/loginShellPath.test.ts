// Lock for ops-212-4: a binary that only the login shell's PATH knows (Homebrew under launchd) is
// still found. A fake "login shell" script stands in for $SHELL; no rc file of the user is run.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { defaultOnPath } from './claudeLauncher/claudeLaunch.probe'
import { mergeLoginShellPath, mergePathLists, loginShellPath } from './loginShellPath'

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

  test('a binary only the login PATH knows is found by the launch probe once the boot merge ran', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin' }
    expect(defaultOnPath(env)('faketool')).toBe(false)
    expect(mergeLoginShellPath(env, () => loginShellPath(shell, { PATH: '/usr/bin:/bin' }), 'darwin')).toBe(1)
    expect(env.PATH).toBe(`/usr/bin:/bin:${brewBin}`)
    expect(defaultOnPath(env)('faketool')).toBe(true)
  })

  test('a failing login shell yields undefined, not a throw', () => {
    expect(loginShellPath(join(root, 'no-such-shell'), { PATH: '/usr/bin:/bin' })).toBeUndefined()
  })
})

describe('boot PATH merge', () => {
  test('process entries first, missing login entries appended in order, duplicates and empties dropped', () => {
    expect(mergePathLists('/a::/b:/a', ':/c:/b::/d:/c')).toEqual({ path: '/a:/b:/c:/d', added: 2 })
  })

  test('nothing new leaves PATH as it was', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/a:/b' }
    expect(mergeLoginShellPath(env, () => '/b:/a', 'darwin')).toBe(0)
    expect(env.PATH).toBe('/a:/b')
  })

  test('an unresolved login shell leaves PATH untouched', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin' }
    expect(mergeLoginShellPath(env, () => undefined, 'darwin')).toBe(0)
    expect(env.PATH).toBe('/usr/bin:/bin')
  })

  test('a missing PATH becomes the login PATH', () => {
    const env: NodeJS.ProcessEnv = {}
    expect(mergeLoginShellPath(env, () => '/x:/y', 'linux')).toBe(2)
    expect(env.PATH).toBe('/x:/y')
  })

  test('Windows is a no-op and never runs the resolver', () => {
    let ran = 0
    const env: NodeJS.ProcessEnv = { PATH: 'C:\\bin' }
    expect(mergeLoginShellPath(env, () => { ran++; return '/x' }, 'win32')).toBe(0)
    expect(ran).toBe(0)
    expect(env.PATH).toBe('C:\\bin')
  })
})
