// ES-14 label: kemampuan tak mengenal restart. Kunci katalog tak boleh berstatus 'boot', respons API tak memuat `restart`.
import { describe, expect, it } from 'vitest'
import type { IncomingMessage } from 'node:http'
import { Readable } from 'node:stream'
import { CAPABILITIES, CAPABILITY_IDS, DERIVED_FLAGS } from '../shared/featureCapabilities'
import { specFor } from './envRegistry'
import { recorder, setupEnv } from './envSettings.testutil'
import { capabilitiesRoute } from './featureCapabilities.api'
import { settingsGuard } from './featureCapabilities.guard'
import { buildResponse } from './featureCapabilities.service'

const PRIMARY = CAPABILITY_IDS.map((id) => CAPABILITIES[id].primaryKey)
const SUBS = CAPABILITY_IDS.flatMap((id) => (CAPABILITIES[id].subs ?? []).map((s) => s.key))
const DERIVED = DERIVED_FLAGS.map((d) => d.key)
const ALL_KEYS = [...PRIMARY, ...SUBS, ...DERIVED]

describe('registry: tak ada kunci katalog yang butuh restart', () => {
  it('semua kunci primer, sub-opsi, dan turunan ada di registry', () => {
    expect(ALL_KEYS.length).toBe(7 + 1 + DERIVED.length)
    expect(ALL_KEYS.filter((k) => specFor(k) === undefined)).toEqual([])
  })

  it.each([['primer', PRIMARY], ['sub-opsi', SUBS], ['turunan', DERIVED]])('kunci %s tidak berstatus restart boot', (_n, keys) => {
    const boot = keys.filter((k) => specFor(k)?.restart === 'boot')
    expect(boot).toEqual([])
  })
})

describe('GET /api/capabilities tidak memuat restart', () => {
  const ORIGIN = 'http://127.0.0.1:8700'

  it('service.buildResponse: tak ada istilah restart/boot/dangerous pada JSON', () => {
    const body = JSON.stringify(buildResponse({}, { chromium: true, telegramToken: false }, '/tmp/webterm-test-data'))
    expect(body).not.toMatch(/restart|dangerous|"boot"/i)
  })

  it('lewat rute nyata: 200, tujuh kemampuan, tanpa field restart di level mana pun', async () => {
    const h = setupEnv({})
    const req = Object.assign(Readable.from([]), { method: 'GET', headers: { host: '127.0.0.1:8700', origin: ORIGIN }, socket: { remoteAddress: '127.0.0.1' } }) as unknown as IncomingMessage
    const res = recorder()
    const deps = () => ({ service: h.svc, guard: (r: IncomingMessage) => settingsGuard(r, {}, undefined), audit: () => undefined })
    const extras = { env: h.target, detect: () => ({ chromium: true, telegramToken: false }), dataDir: '/tmp/webterm-test-data', secrets: h.secrets, fetch: (async () => new Response('{}')) as never }
    const handled = await capabilitiesRoute(req, res, 'GET', '/api/capabilities', deps, extras)
    expect(handled).toBe(true)
    expect(res.status).toBe(200)
    const json = res.json() as { capabilities: unknown[] }
    expect(json.capabilities).toHaveLength(CAPABILITY_IDS.length)
    const keys = new Set<string>()
    JSON.stringify(json, (k, v) => { keys.add(k); return v })
    expect([...keys].filter((k) => /restart/i.test(k))).toEqual([])
    expect(res.body).not.toMatch(/restart/i)
  })
})
