import { describe, expect, it } from 'vitest'
import { allowKey, isAllowed, isLocalName, parseAllowHosts } from './ssrf.allowlist'

const SELF = 8700

describe('parseAllowHosts', () => {
  it('kosong/undefined = daftar kosong', () => {
    for (const raw of [undefined, '', '  ,  ']) {
      const r = parseAllowHosts(raw, SELF)
      expect(r.ok && r.hosts.size).toBe(0)
    }
  })

  it('menormalkan host:port, IPv6 berkurung, koma dan spasi', () => {
    const r = parseAllowHosts('Dev.Local:3000, [::1]:5173 192.168.1.5:8080', SELF)
    if (!r.ok) throw new Error(r.reason)
    expect([...r.hosts].sort()).toEqual(['192.168.1.5:8080', '::1:5173', 'dev.local:3000'].sort())
    expect(isAllowed(r.hosts, 'DEV.LOCAL.', 3000)).toBe(true)
    expect(isAllowed(r.hosts, '[::1]', 5173)).toBe(true)
    expect(isAllowed(r.hosts, 'dev.local', 3001)).toBe(false)
  })

  it.each(['localhost:8700', '127.0.0.1:8700', '[::1]:8700', '0.0.0.0:8700', 'app.localhost:8700'])(
    'port webterm pada loopback menolak SELURUH daftar: %s', (entry) => {
      const r = parseAllowHosts(`dev.local:3000,${entry}`, SELF)
      expect(r.ok).toBe(false)
    })

  it('port yang sama pada host non-loopback tidak di-hard-deny di parser', () => {
    expect(parseAllowHosts('dev.local:8700', SELF).ok).toBe(true)
  })

  it.each(['nohost', ':80', 'a:0', 'a:65536', 'a:b', 'http://a:80', 'a b:80x'])('entri rusak menolak daftar: %s', (entry) => {
    const r = parseAllowHosts(entry, SELF)
    expect(r.ok).toBe(false)
  })
})

describe('helper', () => {
  it('allowKey/isLocalName', () => {
    expect(allowKey('[::1]', 80)).toBe('::1:80')
    expect(isLocalName('localhost')).toBe(true)
    expect(isLocalName('127.0.0.2')).toBe(true)
    expect(isLocalName('example.com')).toBe(false)
  })
})
