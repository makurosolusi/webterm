// Proof that the shim dir stays FIRST on PATH even when a login rc file re-orders it (macOS path_helper, brew shellenv).
// Real zsh/bash run with a temp HOME whose rc puts a "system" dir with its own `open` in front; no browser is involved.
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { captureEnv, withCapturePrefix } from './linkCapture.env'
import { shellKind, shellHookEnv, pathPrefix, BASH_PROMPT_HOOK } from './linkCapture.shell'
import { installLinkCapture, shimDir } from './linkCapture.shims'

const root = mkdtempSync(join(tmpdir(), 'wt-shell-'))
process.env.WEBTERM_DATA_DIR = join(root, 'data')
installLinkCapture()
const sys = join(root, 'sys')
mkdirSync(sys, { recursive: true })
writeFileSync(join(sys, 'open'), '#!/bin/sh\necho system-open\n')
chmodSync(join(sys, 'open'), 0o755)
const have = (sh: string): boolean => { try { execFileSync(sh, ['-c', 'true']); return true } catch { return false } }

/** A HOME whose login + interactive rc files put the "system" dir first, like path_helper does. */
function home(shell: 'zsh' | 'bash', extra = ''): string {
  const h = mkdtempSync(join(root, `home-${shell}-`))
  const reorder = `export PATH="${sys}:$PATH"\nexport RC_RAN=1\n${extra}\n`
  for (const f of shell === 'zsh' ? ['.zshenv', '.zprofile'] : ['.bash_profile']) writeFileSync(join(h, f), reorder)
  return h
}
const sessionEnv = (h: string, shell: string, interactive: boolean): Record<string, string> => ({
  HOME: h, PATH: `/usr/bin:/bin`, ...captureEnv({ nodeId: 'n1', agent: false, port: 8700, shell, interactive, writeFiles: false }, { PATH: '/usr/bin:/bin' }),
})
const first = `command -v open; echo "rc=\${RC_RAN:-no}"; echo "zdot=\${ZDOTDIR-unset}"`

describe('shell kinds and helpers', () => {
  it('names shells by binary, ignoring a login dash', () => {
    expect([shellKind('/bin/zsh'), shellKind('-bash'), shellKind('/usr/bin/fish'), shellKind('/bin/dash'), shellKind('/bin/tcsh')]).toEqual(['zsh', 'bash', 'fish', 'posix', 'other'])
  })
  it('hooks only the shells that have one; the prompt hook keeps an existing PROMPT_COMMAND', () => {
    expect(shellHookEnv('/usr/bin/fish', '/b', {})).toEqual({})
    expect(shellHookEnv('/bin/bash', '/b', { PROMPT_COMMAND: 'history -a' }).PROMPT_COMMAND).toBe(`${BASH_PROMPT_HOOK}; history -a`)
    expect(shellHookEnv('/bin/zsh', '/b', { ZDOTDIR: '/mine' })).toMatchObject({ WEBTERM_ORIG_ZDOTDIR: '/mine' })
    expect(shellHookEnv('/bin/zsh', '/b', {}).WEBTERM_ORIG_ZDOTDIR).toBe('unset')
  })
  it('prefixes a command launch per shell syntax and not at all for an unknown shell', () => {
    expect(pathPrefix('/bin/zsh', "/d ir")).toBe(`PATH='/d ir':"$PATH"; export PATH; `)
    expect(pathPrefix('/usr/bin/fish', '/d')).toBe("set -gx PATH '/d' $PATH; ")
    expect(pathPrefix('/bin/tcsh', '/d')).toBe('')
  })
})

describe.each(['zsh', 'bash'] as const)('%s keeps the shim dir first', (sh) => {
  const bin = sh === 'zsh' ? '/bin/zsh' : '/bin/bash'
  const run = it.skipIf(!have(bin))

  run('control: without capture the rc-ordered system open wins', () => {
    const r = spawnSync(bin, ['-l', '-c', first], { env: { HOME: home(sh), PATH: '/usr/bin:/bin' }, encoding: 'utf8' })
    expect(r.stdout).toContain(join(sys, 'open'))
  })

  run('a command launch (-l -c) puts the shim dir first AFTER the login rc ran', () => {
    const h = home(sh)
    const r = spawnSync(bin, ['-l', '-c', withCapturePrefix(first, bin)], { env: sessionEnv(h, bin, false), encoding: 'utf8' })
    expect(r.stdout.split('\n')[0]).toBe(join(shimDir(), 'open'))
    expect(r.stdout).toContain('rc=1')
  })

  run('an interactive login shell gets it before the first prompt, and the user rc still ran', () => {
    const h = home(sh)
    const r = spawnSync(bin, ['-l', '-i'], { env: sessionEnv(h, bin, true), input: `${first}\nexit\n`, encoding: 'utf8' })
    expect(r.stdout).toContain(join(shimDir(), 'open'))
    expect(r.stdout).not.toContain(`${join(sys, 'open')}\n`)
    expect(r.stdout).toContain('rc=1')
  })
})

describe('zsh ZDOTDIR handling', () => {
  const run = it.skipIf(!have('/bin/zsh'))

  run('restores the user ZDOTDIR and runs the user .zshenv from it', () => {
    const h = home('zsh')
    const mine = mkdtempSync(join(root, 'zdot-'))
    writeFileSync(join(mine, '.zshenv'), 'export FROM_USER_ZDOTDIR=yes\n')
    const env = { ...sessionEnv(h, '/bin/zsh', true), ...shellHookEnv('/bin/zsh', shimDir(), { ZDOTDIR: mine }) }
    const r = spawnSync('/bin/zsh', ['-l', '-i'], { env, input: 'echo "user=$FROM_USER_ZDOTDIR zdot=$ZDOTDIR"\nexit\n', encoding: 'utf8' })
    expect(r.stdout).toContain(`user=yes zdot=${mine}`)
  })

  run('leaves ZDOTDIR unset when the user had none', () => {
    const r = spawnSync('/bin/zsh', ['-l', '-i'], { env: sessionEnv(home('zsh'), '/bin/zsh', true), input: 'echo "zdot=${ZDOTDIR-unset}"\nexit\n', encoding: 'utf8' })
    expect(r.stdout).toContain('zdot=unset')
  })
})
