// Penjaga mutasi: jalur A (token root) dan B (loopback tanpa token), plus statis V4 (tool central tak menyentuh settings).
import { readdirSync, readFileSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { settingsGuard } from './featureCapabilities.guard'

const ROOT_TOKEN = 'root-token-test-only-0123456789abcdef' // test-only
const GOOD = { host: '127.0.0.1:8700', origin: 'http://127.0.0.1:8700' }

function req(headers: Record<string, string>, peer = '127.0.0.1'): IncomingMessage {
  return { headers, socket: { remoteAddress: peer } } as unknown as IncomingMessage
}
const guard = (headers: Record<string, string>, opts: { peer?: string; token?: string } = {}) =>
  settingsGuard(req(headers, opts.peer), opts.token)

describe('jalur B (tanpa token ditegakkan)', () => {
  it('loopback + Origin sama lolos sebagai ui', () => {
    expect(guard(GOOD)).toEqual({ ok: true, via: 'ui' })
    expect(guard(GOOD, { peer: '::ffff:127.0.0.1' })).toEqual({ ok: true, via: 'ui' })
  })

  it.each([
    ['X-Forwarded-For', { ...GOOD, 'x-forwarded-for': '1.2.3.4' }],
    ['Forwarded', { ...GOOD, forwarded: 'for=1.2.3.4' }],
  ])('%s ditolak', (_n, headers) => expect(guard(headers)).toEqual({ ok: false, reason: 'forwarded' }))

  it('Origin asing, "null", dan absen ditolak', () => {
    expect(guard({ ...GOOD, origin: 'http://evil.example' })).toEqual({ ok: false, reason: 'origin' })
    expect(guard({ ...GOOD, origin: 'null' })).toEqual({ ok: false, reason: 'origin' })
    expect(guard({ host: GOOD.host })).toEqual({ ok: false, reason: 'origin' })
  })

  it('peer non-loopback tanpa token ditolak', () => {
    expect(guard(GOOD, { peer: '10.0.0.5' })).toEqual({ ok: false, reason: 'peer' })
  })

  it('token node/capability tanpa root ditegakkan ditolak sebagai token_kind', () => {
    expect(guard({ ...GOOD, 'x-webterm-token': 'node-token-abc' })).toEqual({ ok: false, reason: 'token_kind' })
    expect(guard({ ...GOOD, 'x-webterm-capability': 'wcap_abc' })).toEqual({ ok: false, reason: 'token_kind' })
  })
})

describe('jalur A (token root ditegakkan)', () => {
  it('token root valid lolos dari peer mana pun, tanpa Origin', () => {
    expect(guard({ 'x-webterm-token': ROOT_TOKEN }, { token: ROOT_TOKEN, peer: '10.0.0.5' })).toEqual({ ok: true, via: 'token' })
  })

  it('token node, token salah, capability, atau tanpa token ditolak', () => {
    const bad: Array<Record<string, string>> = [{ 'x-webterm-token': 'node-token-abc' }, { 'x-webterm-capability': 'wcap_abc' }, {}, { ...GOOD }]
    for (const headers of bad) {
      expect(guard(headers, { token: ROOT_TOKEN })).toEqual({ ok: false, reason: 'token_kind' })
    }
    expect(guard({ 'x-webterm-token': ROOT_TOKEN, 'x-webterm-capability': 'wcap_abc' }, { token: ROOT_TOKEN })).toMatchObject({ ok: false })
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
