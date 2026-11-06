import { describe, expect, it } from 'vitest'
import { TOKEN_HEADER, authorize, authorizeRequest, denyReason, logAuthReject } from './auth'
import { buildAllowedHosts } from './hostAllow'

const EVIL = 'evil.example:8700'
const SELF = '127.0.0.1:8700'
const list = buildAllowedHosts({ host: '127.0.0.1', port: 8700, env: {} })
const evil = { host: EVIL, origin: `http://${EVIL}` }
const self = { host: SELF, origin: `http://${SELF}` }

describe('allowedHosts di authorize', () => {
  const T = { [TOKEN_HEADER]: 'tok' }
  const ok = (headers: Record<string, unknown>, allowedHosts?: Parameters<typeof authorize>[0]['allowedHosts']) =>
    authorize({ headers: { ...headers, ...T } as never, expectedToken: 'tok', allowedHosts })

  it('Host asing + Origin asing cocok: ditolak saat allowlist aktif, lolos saat undefined', () => {
    expect(ok(evil, list)).toBe(false)
    expect(ok(evil)).toBe(true)
  })

  it('fungsi pengembali undefined = jalur mati; pengembali list = aktif (per request)', () => {
    expect(ok(evil, () => undefined)).toBe(true)
    expect(ok(evil, () => list)).toBe(false)
  })

  it('Host sendiri lolos; Host array/kosong ditolak', () => {
    expect(ok(self, list)).toBe(true)
    expect(ok({ host: [SELF, SELF] }, list)).toBe(false)
    expect(ok({}, list)).toBe(false)
  })

  it('Host ok tetap tunduk pada token', () => {
    expect(authorize({ headers: self, expectedToken: 'tok', allowedHosts: list })).toBe(false)
    expect(authorize({ headers: { ...self, [TOKEN_HEADER]: 'tok' }, expectedToken: 'tok', allowedHosts: list })).toBe(true)
  })
})

describe('allowedHosts di authorizeRequest', () => {
  const base = { expectedToken: 'root', isNodeToken: () => true, isCapabilityToken: () => true }

  it('Host asing menutup juga jalur token node dan capability', () => {
    const headers = { ...evil, [TOKEN_HEADER]: 'node' }
    expect(authorizeRequest({ ...base, headers, pathname: '/api/agent-status', allowedHosts: list })).toBe(false)
    expect(authorizeRequest({ ...base, headers, pathname: '/api/agent-status' })).toBe(true)
    expect(authorizeRequest({ ...base, headers: { ...evil, 'x-webterm-capability': 'wcap_x' }, pathname: '/api/control/x', allowedHosts: list })).toBe(false)
  })

  it('Host sendiri tidak mengubah perilaku lama', () => {
    expect(authorizeRequest({ ...base, headers: { ...self, [TOKEN_HEADER]: 'node' }, pathname: '/api/agent-status', allowedHosts: list })).toBe(true)
  })
})

describe('denyReason + log', () => {
  it("denyReason = 'host' untuk Host asing, tanpa mengubah origin/token", () => {
    expect(denyReason(evil, undefined, list)).toBe('host')
    expect(denyReason(self, 'tok', list)).toBe('token')
    expect(denyReason({ host: SELF, origin: `http://${EVIL}` }, undefined, list)).toBe('origin')
  })

  it('logAuthReject menerima alasan host tanpa melempar', () => {
    expect(() => logAuthReject('/api/x', 'host', 'evil\r\n.example')).not.toThrow()
  })
})
