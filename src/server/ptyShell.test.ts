import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { logBus } from './logs'
import { ptyEnv, resolveCwd, resolveShell, shellArgv } from './ptyShell'

const only = (...present: string[]) => (bin: string) => present.includes(bin)

describe('resolveShell', () => {
  it('memakai setting bila ada, lalu $SHELL, lalu zsh di darwin, lalu bash', () => {
    const all = only('/opt/fish', '/bin/zsh', '/bin/bash', '/usr/bin/ksh')
    expect(resolveShell('/opt/fish', { envShell: '/usr/bin/ksh', platform: 'darwin', exists: all })).toBe('/opt/fish')
    expect(resolveShell('  ', { envShell: '/usr/bin/ksh', platform: 'darwin', exists: all })).toBe('/usr/bin/ksh')
    expect(resolveShell(undefined, { envShell: '', platform: 'darwin', exists: all })).toBe('/bin/zsh')
    expect(resolveShell(undefined, { envShell: '', platform: 'linux', exists: all })).toBe('/bin/bash')
  })

  it('melewati kandidat yang tidak ada di disk', () => {
    const exists = only('/bin/bash')
    expect(resolveShell('/gone/zsh', { envShell: '/gone/fish', platform: 'darwin', exists })).toBe('/bin/bash')
  })

  it('jatuh ke sh bila tak ada satu pun', () => {
    expect(resolveShell('/gone', { envShell: '/gone', platform: 'darwin', exists: () => false })).toBe('sh')
  })
})

describe('shellArgv', () => {
  const opts = { exists: () => true, platform: 'linux', envShell: '' }
  it('shell biasa POSIX = login shell', () => {
    for (const sh of ['/bin/bash', '/bin/zsh', '/bin/sh', '/usr/bin/fish', '/bin/dash', '/bin/ksh']) {
      expect(shellArgv(sh, undefined, opts)).toEqual([sh, '-l'])
    }
  })
  it('shell non-POSIX tidak diberi -l', () => {
    expect(shellArgv('/usr/bin/nu', undefined, opts)).toEqual(['/usr/bin/nu'])
  })
  it('jalur perintah/agent tetap -l -c', () => {
    expect(shellArgv('/bin/zsh', 'claude --x', opts)).toEqual(['/bin/zsh', '-l', '-c', 'claude --x'])
  })
})

describe('resolveCwd', () => {
  const home = mkdtempSync(join(tmpdir(), 'ptyshell-home-'))
  const file = join(home, 'a-file')
  writeFileSync(file, '')

  it('meng-expand ~ dan ~/x ke home', () => {
    expect(resolveCwd('~', home)).toBe(home)
    expect(resolveCwd('~/', home)).toBe(home)
    expect(resolveCwd('~/sub', home, () => true)).toBe(join(home, 'sub'))
  })
  it('kosong, tidak ada, atau bukan direktori jatuh ke home', () => {
    expect(resolveCwd(undefined, home)).toBe(home)
    expect(resolveCwd('  ', home)).toBe(home)
    expect(resolveCwd('/definitely/not/here', home)).toBe(home)
    expect(resolveCwd(file, home)).toBe(home)
  })
  it('direktori nyata dipakai apa adanya', () => {
    expect(resolveCwd(tmpdir(), home)).toBe(tmpdir())
  })
})

describe('ptyEnv', () => {
  const source = {
    PATH: '/usr/bin', NODE_ENV: 'production', PORT: '8700', HOST: '0.0.0.0', VITE_X: '1', BUN_RUNTIME: '1', BUN_INSTALL: '/b',
    WEBTERM_TOKEN: 'root-token', WEBTERM_DATA_DIR: '/d', NODETERM_NODE_ID: 'inherited', NODETERM_PORT: '8700',
    NODETERM_NODE_TOKEN: 'inherited-node-token',
  }
  it('membuang variabel internal server, termasuk WEBTERM_*/NODETERM_*, dan mempertahankan BUN_INSTALL', () => {
    const env = ptyEnv(source, { interactive: true, platform: 'linux' })
    const stripped = [
      'NODE_ENV', 'PORT', 'HOST', 'VITE_X', 'BUN_RUNTIME',
      'WEBTERM_TOKEN', 'WEBTERM_DATA_DIR', 'NODETERM_NODE_ID', 'NODETERM_PORT', 'NODETERM_NODE_TOKEN',
    ]
    for (const k of stripped) expect(k in env).toBe(false)
    for (const k of ['PATH', 'BUN_INSTALL']) expect(env[k]).toBe(source[k as keyof typeof source])
  })
  it('tidak membuang nama yang hanya BERAWALAN sama tanpa garis bawah', () => {
    const env = ptyEnv({ WEBTERMAPP: '1', NODETERMX: '2', PATH: '/x' }, { interactive: false })
    expect(env).toEqual({ WEBTERMAPP: '1', NODETERMX: '2', PATH: '/x', TERM: 'xterm-256color' })
  })
  it('shell biasa: identitas terminal + locale default per platform', () => {
    const mac = ptyEnv(source, { interactive: true, platform: 'darwin' })
    expect([mac.TERM, mac.TERM_PROGRAM, mac.COLORTERM, mac.LANG]).toEqual(['xterm-256color', 'webterm', 'truecolor', 'en_US.UTF-8'])
    expect(ptyEnv(source, { interactive: true, platform: 'linux' }).LANG).toBe('C.UTF-8')
  })
  it('locale yang sudah ada tidak ditimpa', () => {
    expect(ptyEnv({ LANG: 'id_ID.UTF-8' }, { interactive: true }).LANG).toBe('id_ID.UTF-8')
    expect('LANG' in ptyEnv({ LC_ALL: 'C' }, { interactive: true })).toBe(false)
  })
  it('jalur agent tidak mendapat TERM_PROGRAM/COLORTERM/LANG tambahan', () => {
    const env = ptyEnv({ PATH: '/x' }, { interactive: false })
    expect(env).toEqual({ PATH: '/x', TERM: 'xterm-256color' })
  })
})

describe('resolveShell: warn path hilang', () => {
  it('warn SEKALI per path yang hilang, meski dipanggil berulang', () => {
    const missing = '/tmp/st-no-such-shell-warn-once'
    const count = () => logBus.query({}).filter((e) => e.event === 'pty.shell_missing' && e.data?.shell === missing).length
    const opts = { envShell: '', platform: 'linux', exists: only('/bin/bash') }
    expect(resolveShell(missing, opts)).toBe('/bin/bash')
    expect(resolveShell(missing, opts)).toBe('/bin/bash')
    expect(count()).toBe(1)
    const e = logBus.query({}).find((x) => x.data?.shell === missing)
    expect(e).toMatchObject({ level: 'warn', data: { shell: missing, fallback: '/bin/bash' } })
  })

  it('tidak warn bila setting valid atau kosong', () => {
    const before = logBus.query({}).filter((e) => e.event === 'pty.shell_missing').length
    resolveShell('/bin/bash', { envShell: '', platform: 'linux', exists: only('/bin/bash') })
    resolveShell('  ', { envShell: '', platform: 'linux', exists: only('/bin/bash') })
    expect(logBus.query({}).filter((e) => e.event === 'pty.shell_missing').length).toBe(before)
  })
})
