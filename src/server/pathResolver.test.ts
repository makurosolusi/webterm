import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { compatOf, incompatMessage, platformDirName, sniffBinary } from './binaryFormat'
import { setExtraPathDirs, withCustomBin } from './customBinPath'
import { detectCommands } from './customCommands.detect'
import { addPathDir } from './customCommands.paths'
import { wrapperMissingNotice } from './launchLine'
import {
  configurePathResolver, incompatReasonFor, probeHomeBinDirs, refreshOnMiss, rescan, resetPathResolverForTest, resolveBinary,
  scanToolDirs, sessionFoundDirs, takeFoundNotices,
} from './pathResolver'
import type { CustomCommandsCtx } from './customCommands.store'

let root: string
const put = (path: string, bytes: Buffer | string, mode = 0o755): string => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, bytes); chmodSync(path, mode)
  return path
}
const u32be = (...v: number[]): Buffer => { const b = Buffer.alloc(v.length * 4); v.forEach((n, i) => b.writeUInt32BE(n, i * 4)); return b }
/** Header-only fixtures: enough bytes for the sniffer, not runnable programs. */
const ELF = (machine: number): Buffer => { const b = Buffer.alloc(64); b.write('\x7fELF', 0, 'latin1'); b[4] = 2; b[5] = 1; b.writeUInt16LE(machine, 18); return b }
const MACHO_ARM64 = Buffer.concat([Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), Buffer.from([0x0c, 0x00, 0x00, 0x01]), Buffer.alloc(24)])
const MACHO_FAT = Buffer.concat([u32be(0xcafebabe, 2, 0x01000007, 3, 0x1000, 0x1000, 12), u32be(0x0100000c, 0, 0x2000, 0x1000, 12)])
const PE = (machine: number): Buffer => { const b = Buffer.alloc(128); b.write('MZ', 0, 'latin1'); b.writeUInt32LE(0x40, 0x3c); b.write('PE\0\0', 0x40, 'latin1'); b.writeUInt16LE(machine, 0x44); return b }

beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'wt-pr-'))); resetPathResolverForTest() })
afterEach(() => { rmSync(root, { recursive: true, force: true }); resetPathResolverForTest() })

describe('binary format sniffing (header only)', () => {
  const sniff = (name: string, bytes: Buffer | string) => sniffBinary(put(join(root, name), bytes))
  it('reads ELF, Mach-O (thin and universal), PE and scripts', () => {
    expect(sniff('a', ELF(0xb7))).toEqual({ format: 'elf', os: 'linux', archs: ['arm64'] })
    expect(sniff('b', ELF(0x3e))).toEqual({ format: 'elf', os: 'linux', archs: ['amd64'] })
    expect(sniff('c', MACHO_ARM64)).toEqual({ format: 'macho', os: 'darwin', archs: ['arm64'] })
    expect(sniff('d', MACHO_FAT)).toEqual({ format: 'macho', os: 'darwin', archs: ['amd64', 'arm64'] })
    expect(sniff('e', PE(0x8664))).toEqual({ format: 'pe', os: 'windows', archs: ['amd64'] })
    expect(sniff('f', '#!/bin/sh\n')).toEqual({ format: 'script', archs: [] })
    expect(sniff('g', 'plain text')).toEqual({ format: 'unknown', archs: [] })
    expect(sniffBinary(join(root, 'missing')).format).toBe('unknown')
  })
  it('judges compatibility per os/arch and explains a mismatch', () => {
    const mac = sniff('m', MACHO_ARM64)
    expect(compatOf(mac, 'darwin', 'arm64')).toBe('ok')
    expect(compatOf(mac, 'linux', 'arm64')).toBe('wrong_platform')
    expect(compatOf(mac, 'darwin', 'x64')).toBe('wrong_arch')
    expect(compatOf(sniff('x', ELF(0x3e)), 'darwin', 'arm64')).toBe('wrong_platform')
    expect(compatOf(sniff('e', ELF(0xb7)), 'linux', 'x64')).toBe('wrong_arch')
    expect(compatOf({ format: 'macho', os: 'darwin', archs: ['amd64'] }, 'darwin', 'arm64')).toBe('ok') // Rosetta
    expect(compatOf(sniff('s', '#!/bin/sh\n'), 'linux', 'arm64')).toBe('ok')
    expect(compatOf(sniff('u', 'plain text'), 'linux', 'arm64')).toBe('unknown')
    expect(incompatMessage('envman', mac, 'linux', 'arm64')).toBe('envman is a macOS arm64 binary; this machine is linux/arm64 — add a linux-arm64 build next to it')
    expect(incompatMessage('envman', mac, 'darwin', 'arm64')).toBeNull()
  })
  it('never runs the file it inspects', () => {
    const marker = join(root, 'ran')
    const script = put(join(root, 'tool'), `#!/bin/sh\ntouch ${marker}\n`)
    expect(sniffBinary(script).format).toBe('script')
    expect(incompatReasonFor('tool', { PATH: root })).toBeNull()
    expect(existsSync(marker)).toBe(false)
  })
  it('incompatReasonFor flags a binary built for the other OS', () => {
    put(join(root, 'foreign'), process.platform === 'darwin' ? ELF(0x3e) : MACHO_ARM64)
    expect(incompatReasonFor('foreign', { PATH: root })).toMatch(/^foreign is a .* binary; this machine is /)
    expect(wrapperMissingNotice('foreign', incompatReasonFor('foreign', { PATH: root }))).toContain('launched without it')
  })
})

describe('platform subfolder convention', () => {
  it('puts <dir>/<os>-<arch> right before its parent, managed dir first, extras after', () => {
    const bin = join(root, 'bin'); const extra = join(root, 'extra')
    mkdirSync(join(bin, platformDirName()), { recursive: true }); mkdirSync(join(extra, platformDirName()), { recursive: true })
    mkdirSync(join(root, 'plain'))
    expect(withCustomBin('/usr/bin', bin, [extra, join(root, 'plain')])).toBe(
      [join(bin, platformDirName()), bin, join(extra, platformDirName()), extra, join(root, 'plain'), '/usr/bin'].join(':'),
    )
  })
  it('ignores subfolders that are not this machine', () => {
    const bin = join(root, 'bin')
    mkdirSync(join(bin, platformDirName() === 'linux-arm64' ? 'darwin-arm64' : 'linux-arm64'), { recursive: true })
    expect(withCustomBin('/usr/bin', bin, [])).toBe(`${bin}:/usr/bin`)
  })
  it('detect lists tools from the matching subfolder with format and source', () => {
    const ctx: CustomCommandsCtx = { binDir: join(root, 'bin'), registryFile: join(root, 'cc.json'), pathEnv: () => '/usr/bin', now: () => 1 }
    put(join(ctx.binDir, platformDirName(), 'envman'), '#!/bin/sh\n')
    put(join(ctx.binDir, 'other'), process.platform === 'darwin' ? ELF(0x3e) : MACHO_ARM64)
    const d = detectCommands(ctx)
    expect(d.find((x) => x.name === 'envman')).toMatchObject({ found: true, source: 'custom-bin', format: 'script', compat: 'ok' })
    expect(d.find((x) => x.name === 'other')).toMatchObject({ found: true, compat: expect.stringMatching(/^wrong_/), compatMessage: expect.stringContaining('other is a') })
    expect(d.find((x) => x.name === 'op')).toMatchObject({ found: expect.any(Boolean), source: expect.stringMatching(/path|candidate/) })
  })
})

describe('resolver: miss handling', () => {
  it('finds a tool installed after boot in an extra dir, then rate limits repeated misses', () => {
    const extra = join(root, 'tools'); mkdirSync(extra)
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin', HOME: join(root, 'home'), WEBTERM_CUSTOM_BIN: join(root, 'cb') }
    configurePathResolver({ loadExtras: () => [extra] })
    expect(resolveBinary('late-tool', env)).toBeUndefined()
    const file = put(join(extra, 'late-tool'), '#!/bin/sh\n')
    expect(env.PATH?.split(':').slice(0, 2)).toEqual([join(root, 'cb'), extra]) // managed dir first, extras next
    expect(resolveBinary('late-tool', env)).toBe(file) // the extra dir is already on PATH: no rescan needed
    expect(refreshOnMiss('late-tool', Date.now() + 16_000, env)).toBe(false) // nothing new to add
  })
  it('a dir that appears after the first miss is picked up once the interval passes', () => {
    const home = join(root, 'home'); const dir = join(home, '.local/bin'); mkdirSync(home)
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin', HOME: home, WEBTERM_CUSTOM_BIN: join(root, 'cb') }
    refreshOnMiss('t', 1000, env) // first miss: only the managed dir is put on PATH
    mkdirSync(dir, { recursive: true })
    expect(refreshOnMiss('t', 1100, env)).toBe(false) // rate limited
    expect(env.PATH).not.toContain(dir)
    expect(refreshOnMiss('t', 17_000, env)).toBe(true)
    expect(env.PATH).toContain(dir)
  })
  it('rescan ignores the rate limit, drops removed extras and merges the login shell PATH', async () => {
    const extra = join(root, 'tools'); mkdirSync(extra)
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin', HOME: join(root, 'h'), WEBTERM_CUSTOM_BIN: join(root, 'cb') }
    let extras = [extra]
    configurePathResolver({ loadExtras: () => extras, loginPath: async () => '/usr/bin:/opt/from-login' })
    refreshOnMiss('x', 1, env)
    expect(env.PATH).toContain(extra)
    extras = []
    const r = await rescan(env)
    expect(r.added).toBeGreaterThanOrEqual(1)
    expect(env.PATH).toContain('/opt/from-login')
    expect(env.PATH).not.toContain(extra)
  })
  it('rejects world-writable extra dirs and ignores them when scanning', () => {
    const open = join(root, 'open'); mkdirSync(open); chmodSync(open, 0o777)
    const ctx: CustomCommandsCtx = { binDir: join(root, 'bin'), registryFile: join(root, 'cc.json'), pathEnv: () => '/usr/bin', now: () => 1 }
    expect(addPathDir(ctx, open)).toMatchObject({ ok: false, code: 'unsafe_path_dir' })
    expect(addPathDir(ctx, '../x')).toMatchObject({ ok: false, code: 'invalid_path_dir' })
    expect(addPathDir(ctx, 'rel')).toMatchObject({ ok: false, code: 'invalid_path_dir' })
    expect(addPathDir(ctx, join(root, 'nope'))).toMatchObject({ ok: false, code: 'invalid_path_dir' })
    configurePathResolver({ loadExtras: () => [open] })
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin', HOME: join(root, 'h'), WEBTERM_CUSTOM_BIN: join(root, 'cb') }
    scanToolDirs(env)
    expect(env.PATH).not.toContain(open)
  })
  it('adds, dedupes, limits and removes extra dirs', () => {
    const ctx: CustomCommandsCtx = { binDir: join(root, 'bin'), registryFile: join(root, 'cc.json'), pathEnv: () => '/usr/bin', now: () => 1 }
    const d = join(root, 'd0'); mkdirSync(d)
    expect(addPathDir(ctx, `${d}/`)).toMatchObject({ ok: true, data: { extra: [{ dir: d, exists: true, safe: true }] } })
    expect(addPathDir(ctx, d)).toMatchObject({ ok: false, code: 'duplicate' })
    for (let i = 1; i < 16; i++) { const x = join(root, `d${i}`); mkdirSync(x); expect(addPathDir(ctx, x).ok).toBe(true) }
    const extra = join(root, 'd16'); mkdirSync(extra)
    expect(addPathDir(ctx, extra)).toMatchObject({ ok: false, code: 'limit_reached' })
  })
})

describe('home probe for installer-style dirs', () => {
  const envFor = (home: string): NodeJS.ProcessEnv => ({ PATH: '/usr/bin', HOME: home, WEBTERM_CUSTOM_BIN: join(root, 'cb') })
  it('finds ~/.foo/bin on a miss, adds it for this session only and says so', () => {
    const home = join(root, 'home'); const marker = join(root, 'ran')
    put(join(home, '.foo/bin/foo'), `#!/bin/sh\ntouch ${marker}\n`)
    const env = envFor(home)
    expect(resolveBinary('foo', env)).toBe(join(home, '.foo/bin/foo'))
    expect(env.PATH?.startsWith(`${join(root, 'cb')}:/usr/bin`)).toBe(true)
    expect(env.PATH?.endsWith(`:${join(home, '.foo/bin')}`)).toBe(true) // appended last, this session only
    expect(sessionFoundDirs()).toEqual([{ name: 'foo', dir: join(home, '.foo/bin') }])
    expect(takeFoundNotices()).toEqual(['foo was found in ~/.foo/bin and added to PATH for this session. Add it permanently: webterm command path add ~/.foo/bin'])
    expect(takeFoundNotices()).toEqual([])
    expect(existsSync(marker)).toBe(false) // never executed
  })
  it('also looks in ~/go/bin style plain dirs', () => {
    const home = join(root, 'home')
    put(join(home, 'go/bin/gotool'), '#!/bin/sh\n')
    expect(probeHomeBinDirs('gotool', envFor(home))).toBe(true)
  })
  it('does not follow a symlink out of HOME', () => {
    const home = join(root, 'home'); const outside = join(root, 'outside')
    put(join(outside, 'bin/evil'), '#!/bin/sh\n'); mkdirSync(home, { recursive: true })
    symlinkSync(outside, join(home, '.sneaky'))
    mkdirSync(join(home, '.linked'), { recursive: true }); symlinkSync(join(outside, 'bin'), join(home, '.linked/bin'))
    const env = envFor(home)
    expect(probeHomeBinDirs('evil', env)).toBe(false)
    expect(env.PATH).toBe('/usr/bin')
  })
  it('skips binaries for another platform and world-writable dirs', () => {
    const home = join(root, 'home')
    put(join(home, '.alien/bin/alien'), process.platform === 'darwin' ? ELF(0x3e) : MACHO_ARM64)
    put(join(home, '.open/bin/open'), '#!/bin/sh\n'); chmodSync(join(home, '.open/bin'), 0o777)
    expect(probeHomeBinDirs('alien', envFor(home))).toBe(false)
    expect(probeHomeBinDirs('open', envFor(home))).toBe(false)
  })
  it('checks at most 64 directories and respects the time budget', () => {
    const home = join(root, 'home')
    for (let i = 0; i < 70; i++) mkdirSync(join(home, `.a${String(i).padStart(2, '0')}`, 'bin'), { recursive: true })
    put(join(home, '.zz/bin/late'), '#!/bin/sh\n')
    expect(probeHomeBinDirs('late', envFor(home))).toBe(false)
    put(join(home, '.a00/bin/early'), '#!/bin/sh\n')
    expect(probeHomeBinDirs('early', envFor(home))).toBe(true)
    expect(probeHomeBinDirs('early2', envFor(home), -1)).toBe(false)
  })
  it('leaves extra dirs unchanged (nothing persisted)', () => {
    setExtraPathDirs([])
    put(join(root, 'home/.foo/bin/foo'), '#!/bin/sh\n')
    probeHomeBinDirs('foo', envFor(join(root, 'home')))
    expect(withCustomBin('/usr/bin', '/cb')).toBe('/cb:/usr/bin')
  })
})
