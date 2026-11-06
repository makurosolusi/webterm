// Penjaga mutasi: jalur A (token root) dan B (halaman webterm bercookie `wt_ui`), plus statis V4 (tool central tak menyentuh settings).
import { TEST_UI_COOKIE } from './uiSession.testutil'
import { readdirSync, readFileSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { settingsGuard } from './featureCapabilities.guard'

const ROOT_TOKEN = 'root-token-test-only-0123456789abcdef' // test-only
const GOOD = { host: '127.0.0.1:8700', origin: 'http://127.0.0.1:8700', cookie: TEST_UI_COOKIE }

function req(headers: Record<string, string>, peer = '127.0.0.1'): IncomingMessage {
  return { headers, socket: { remoteAddress: peer } } as unknown as IncomingMessage
}
const guard = (headers: Record<string, string>, opts: { peer?: string; token?: string; read?: boolean } = {}) =>
  settingsGuard(req(headers, opts.peer), opts.token ?? ROOT_TOKEN, opts.read ? 'read' : 'write')

describe('jalur B (halaman webterm: cookie wt_ui hidup)', () => {
  it('cookie + Origin sama lolos sebagai ui dari peer mana pun, di balik proxy juga', () => {
    expect(guard(GOOD)).toEqual({ ok: true, via: 'ui' })
    expect(guard(GOOD, { peer: '10.0.0.5' })).toEqual({ ok: true, via: 'ui' })
    expect(guard({ ...GOOD, 'x-forwarded-for': '1.2.3.4', forwarded: 'for=1.2.3.4' })).toEqual({ ok: true, via: 'ui' })
  })

  it('tanpa cookie, cookie palsu, atau cookie lain ditolak sebagai session, juga dari loopback', () => {
    const { cookie: _cookie, ...noCookie } = GOOD
    expect(guard(noCookie)).toEqual({ ok: false, reason: 'session' })
    expect(guard({ ...GOOD, cookie: 'wt_ui=forged' })).toEqual({ ok: false, reason: 'session' })
    expect(guard({ ...GOOD, cookie: 'other=1' })).toEqual({ ok: false, reason: 'session' })
    expect(guard(noCookie, { token: undefined })).toEqual({ ok: false, reason: 'session' })
  })

  it('tulis: Origin asing, "null", dan absen ditolak walau cookie hidup', () => {
    expect(guard({ ...GOOD, origin: 'http://evil.example' })).toEqual({ ok: false, reason: 'origin' })
    expect(guard({ ...GOOD, origin: 'null' })).toEqual({ ok: false, reason: 'origin' })
    expect(guard({ host: GOOD.host, cookie: GOOD.cookie })).toEqual({ ok: false, reason: 'origin' })
  })

  it('baca: GET sama-origin tanpa Origin lolos dengan cookie, tidak tanpa cookie', () => {
    expect(guard({ host: GOOD.host, cookie: GOOD.cookie }, { read: true })).toEqual({ ok: true, via: 'ui' })
    expect(guard({ host: GOOD.host }, { read: true })).toEqual({ ok: false, reason: 'session' })
  })

  it('token node/salah atau capability di samping cookie ditolak sebagai token_kind', () => {
    expect(guard({ ...GOOD, 'x-webterm-token': 'node-token-abc' })).toEqual({ ok: false, reason: 'token_kind' })
    expect(guard({ ...GOOD, 'x-webterm-capability': 'wcap_abc' })).toEqual({ ok: false, reason: 'token_kind' })
    expect(guard({ ...GOOD, 'x-webterm-token': 'node-token-abc' }, { read: true })).toEqual({ ok: false, reason: 'token_kind' })
  })
})

describe('jalur A (token root)', () => {
  it('token root valid lolos dari peer mana pun, tanpa Origin', () => {
    expect(guard({ 'x-webterm-token': ROOT_TOKEN }, { peer: '10.0.0.5' })).toEqual({ ok: true, via: 'token' })
  })

  it('token node, token salah, capability, tanpa token, atau tanpa token root terpasang ditolak', () => {
    expect(guard({ 'x-webterm-token': 'node-token-abc' })).toEqual({ ok: false, reason: 'token_kind' })
    expect(guard({ 'x-webterm-capability': 'wcap_abc' })).toEqual({ ok: false, reason: 'token_kind' })
    expect(guard({})).toEqual({ ok: false, reason: 'origin' })
    expect(guard({ 'x-webterm-token': ROOT_TOKEN, 'x-webterm-capability': 'wcap_abc' })).toEqual({ ok: false, reason: 'token_kind' })
    expect(settingsGuard(req({ 'x-webterm-token': ROOT_TOKEN }), undefined)).toEqual({ ok: false, reason: 'token_kind' })
  })
})

describe('statis V4', () => {
  it('tidak ada def tool central yang mengimpor modul settings/capabilities', () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), 'central/tools/defs')
    const defs = readdirSync(dir).filter((f) => f.endsWith('.def.ts'))
    expect(defs.length).toBeGreaterThan(0)
    for (const f of defs) {
      expect(readFileSync(join(dir, f), 'utf8'), f).not.toMatch(/from\s+['"][^'"]*(envSettings|featureCapabilities)/)
    }
  })
})
