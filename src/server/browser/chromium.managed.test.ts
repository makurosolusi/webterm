import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { archiveUrl, cftPlatform, CHROME_FOR_TESTING_VERSION, installManaged, managedBinaryPath } from './chromium.managed'
import { extractZip, safeJoin } from './chromium.managed.zip'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'wt-managed-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

interface Entry { name: string; data?: string; mode?: number; deflate?: boolean }
// test-only: builds a zip in memory (store or deflate, unix modes) so no real Chrome archive is ever needed.
function makeZip(entries: Entry[]): Buffer {
  const locals: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.from(e.name)
    const raw = Buffer.from(e.data ?? '')
    const method = e.deflate ? 8 : 0
    const body = e.deflate ? deflateRawSync(raw) : raw
    const l = Buffer.alloc(30)
    l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(20, 4); l.writeUInt16LE(method, 8)
    l.writeUInt32LE(body.length, 18); l.writeUInt32LE(raw.length, 22); l.writeUInt16LE(name.length, 26)
    const c = Buffer.alloc(46)
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE((3 << 8) | 20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(method, 10)
    c.writeUInt32LE(body.length, 20); c.writeUInt32LE(raw.length, 24); c.writeUInt16LE(name.length, 28)
    c.writeUInt32LE(((e.mode ?? 0o100644) << 16) >>> 0, 38); c.writeUInt32LE(offset, 42)
    locals.push(l, name, body)
    central.push(c, name)
    offset += 30 + name.length + body.length
  }
  const cen = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(cen.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cen, end])
}

describe('extractZip', () => {
  it('extracts files (deflate + store), dirs, modes and an in-tree symlink', () => {
    extractZip(makeZip([
      { name: 'a/' , mode: 0o40755 },
      { name: 'a/run', data: 'echo hi', mode: 0o100755, deflate: true },
      { name: 'a/data.txt', data: 'x' },
      { name: 'a/link', data: 'run', mode: 0o120777 },
    ]), dir)
    expect(readFileSync(join(dir, 'a/run'), 'utf8')).toBe('echo hi')
    expect(statSync(join(dir, 'a/run')).mode & 0o111).not.toBe(0)
    expect(lstatSync(join(dir, 'a/link')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(dir, 'a/link'))).toBe('run')
  })
  it('rejects zip-slip, absolute paths and escaping symlinks without writing anything outside', () => {
    for (const name of ['../evil', 'a/../../evil', '/etc/evil', 'C:/evil', 'a\\..\\evil']) {
      expect(() => extractZip(makeZip([{ name, data: 'x' }]), join(dir, 'out'))).toThrow(/escapes/)
    }
    expect(() => extractZip(makeZip([{ name: 'l', data: '../../x', mode: 0o120777 }]), join(dir, 'out'))).toThrow(/symlink escapes/)
    expect(() => extractZip(makeZip([{ name: 'l', data: '/etc/passwd', mode: 0o120777 }]), join(dir, 'out'))).toThrow(/symlink escapes/)
    expect(existsSync(join(dir, 'evil'))).toBe(false)
  })
  it('safeJoin keeps plain nested names', () => {
    expect(safeJoin('/d', 'a/b')).toBe('/d/a/b')
  })
})

describe('platform and urls', () => {
  it('maps node platform/arch to Chrome for Testing names; unsupported = null', () => {
    expect(cftPlatform('darwin', 'arm64')).toBe('mac-arm64')
    expect(cftPlatform('darwin', 'x64')).toBe('mac-x64')
    expect(cftPlatform('linux', 'x64')).toBe('linux64')
    expect(cftPlatform('win32', 'x64')).toBe('win64')
    expect(cftPlatform('linux', 'arm64')).toBeNull()
  })
  it('uses the official https bucket with the locked version', () => {
    expect(archiveUrl('linux64')).toBe(`https://storage.googleapis.com/chrome-for-testing-public/${CHROME_FOR_TESTING_VERSION}/linux64/chrome-linux64.zip`)
  })
  it('the Mac app is "Google Chrome for Testing", never "Google Chrome"', () => {
    expect(managedBinaryPath('/r', 'mac-arm64', '1.0')).toBe('/r/1.0/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')
  })
})

describe('installManaged', () => {
  const zip = makeZip([{ name: 'chrome-linux64/chrome', data: '#!/bin/sh', mode: 0o100755, deflate: true }])
  const fakeFetch = (body: Buffer | null, status = 200, urls: string[] = []): typeof fetch =>
    (async (url: string | URL | Request) => { urls.push(String(url)); return new Response(body ? new Uint8Array(body) : null, { status }) }) as typeof fetch

  it('downloads from the official url, extracts atomically and is idempotent', async () => {
    const urls: string[] = []
    const bin = await installManaged(dir, { platform: 'linux64', version: '9.9', fetch: fakeFetch(zip, 200, urls) })
    expect(bin).toBe(join(dir, '9.9', 'chrome-linux64', 'chrome'))
    expect(readFileSync(bin, 'utf8')).toBe('#!/bin/sh')
    expect(urls).toEqual([archiveUrl('linux64', '9.9')])
    const again = await installManaged(dir, { platform: 'linux64', version: '9.9', fetch: fakeFetch(null, 500) })
    expect(again).toBe(bin) // already present: no request made
  })
  it('verifies a pinned SHA-256 and leaves nothing behind on mismatch', async () => {
    const good = createHash('sha256').update(zip).digest('hex')
    await expect(installManaged(dir, { platform: 'linux64', version: '1', fetch: fakeFetch(zip), sha256: { linux64: 'a'.repeat(64) } })).rejects.toThrow(/SHA-256 mismatch/)
    expect(existsSync(join(dir, '1'))).toBe(false)
    await expect(installManaged(dir, { platform: 'linux64', version: '1', fetch: fakeFetch(zip), sha256: { linux64: good } })).resolves.toContain('chrome')
  })
  it('fails with context on HTTP errors, a bad archive, and an unsupported platform', async () => {
    await expect(installManaged(dir, { platform: 'linux64', version: '2', fetch: fakeFetch(null, 404) })).rejects.toThrow(/answered 404/)
    await expect(installManaged(dir, { platform: 'linux64', version: '2', fetch: fakeFetch(makeZip([{ name: 'other', data: 'x' }])) })).rejects.toThrow(/installing 2/)
    expect(existsSync(join(dir, '2'))).toBe(false)
    await expect(installManaged(dir, { platform: null })).rejects.toThrow(/no Chrome for Testing build/)
  })
  it('rejects a response over the size cap by content-length', async () => {
    const big = (async () => new Response('x', { headers: { 'content-length': String(10 ** 10) } })) as unknown as typeof fetch
    await expect(installManaged(dir, { platform: 'linux64', version: '3', fetch: big })).rejects.toThrow(/larger than/)
  })
})
