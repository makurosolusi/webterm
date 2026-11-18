// /api/browser/profiles/*: CRUD codes, cookie import into the TARGET profile only, Google cookies skipped, export round trip.
import { beforeEach, describe, expect, it } from 'vitest'
import type { BrowserStatusResp } from '../shared/browser.contract'
import type { BrowserProfile } from '../shared/browser.profile'
import { handleBrowserApi } from './browserApi'
import type { BrowserApiDeps } from './browserApi'
import { createCookiePreviewStore } from './browser/cookieImport.preview'
import type { BrowserCookie } from './browser/cookieImport.parse'
import { cookie, makeRig } from './browser/browser.profiles.testkit'
import type { Rig } from './browser/browser.profiles.testkit'

let rig: Rig
let d: BrowserApiDeps
let injected: Array<[string, BrowserCookie[]]>
let importEnabled = true

const status = (): BrowserStatusResp => ({ enabled: true, binFound: true, live: 0, maxLive: 3, agentEnabled: true, cookieImportEnabled: importEnabled })
const body = (v: unknown) => () => Promise.resolve(JSON.stringify(v))
const api = (method: string, path: string, v?: unknown, search = '') =>
  handleBrowserApi(method, `/api/browser/profiles${path}`, v === undefined ? () => Promise.resolve('') : body(v), d, new URLSearchParams(search))
const storageState = (cookies: Array<Partial<BrowserCookie> & { name: string; domain: string }>) =>
  JSON.stringify({ cookies: cookies.map((c) => ({ value: 'x', path: '/', expires: -1, httpOnly: false, secure: true, ...c })), origins: [] })

beforeEach(() => {
  importEnabled = true
  injected = []
  rig = makeRig()
  rig.svc.ensureDefaults()
  d = {
    status, vault: rig.vault, preview: createCookiePreviewStore(),
    injector: { inject: async (id, c) => void injected.push([id, c]), remove: async () => undefined },
    lease: { holder: () => 'human', takeover: () => undefined, release: () => undefined },
    setAgentControl: () => undefined,
    profiles: { profiles: rig.svc, ops: rig.ops },
    setNodeProfile: async () => ({ ok: false, code: 'profile_not_found' }),
  }
})

const create = async (name: string): Promise<BrowserProfile> => (await api('POST', '', { name }))!.body as BrowserProfile

describe('profiles CRUD', () => {
  it('lists with live, nodeCount and cookieDomains; scopes by workspaceId', async () => {
    rig.live.add('w1')
    rig.vault.save('w1', [cookie('a.com')])
    const all = (await api('GET', ''))!.body as { profiles: BrowserProfile[] }
    expect(all.profiles.find((p) => p.id === 'w1')).toMatchObject({ live: true, cookieDomains: 1, nodeCount: 0, isDefaultOf: 'w1' })
    const scoped = (await api('GET', '', undefined, 'workspaceId=w2'))!.body as { profiles: BrowserProfile[] }
    expect(scoped.profiles.map((p) => p.id)).toEqual(['w2'])
  })
  it('POST creates (201, random color), duplicate name 409, bad name 400, PUT renames, unknown 404', async () => {
    const made = await api('POST', '', { name: 'Admin' })
    expect(made).toMatchObject({ status: 201, body: { name: 'Admin' } })
    const id = (made!.body as BrowserProfile).id
    expect(await api('POST', '', { name: 'admin' })).toMatchObject({ status: 409, body: { error: 'profile_name_taken' } })
    expect(await api('POST', '', { name: '' })).toMatchObject({ status: 400, body: { error: 'profile_name_invalid' } })
    expect(await api('PUT', `/${id}`, { name: 'Boss', color: 'teal' })).toMatchObject({ status: 200, body: { name: 'Boss', color: 'teal' } })
    expect(await api('PUT', '/bp-missing', { name: 'x' })).toMatchObject({ status: 404, body: { error: 'profile_not_found' } })
  })
  it('DELETE: 409 profile_in_use while a node uses it, 409 profile_default for a board Default, 204 otherwise', async () => {
    const p = await create('Temp')
    rig.boards[0].nodes.push({ id: 'b1', kind: 'browser', x: 0, y: 0, profileId: p.id })
    expect(await api('DELETE', `/${p.id}`)).toMatchObject({ status: 409, body: { error: 'profile_in_use' } })
    expect(await api('DELETE', '/w1')).toMatchObject({ status: 409, body: { error: 'profile_default' } })
    rig.boards[0].nodes.pop()
    expect(await api('DELETE', `/${p.id}`)).toEqual({ status: 204 })
    expect(await api('DELETE', `/${p.id}`)).toMatchObject({ status: 404 })
  })
  it('rejects unsafe ids before touching the disk', async () => {
    for (const id of ['..%2Fx', 'a%2Fb']) expect(await api('GET', `/${id}/export`)).toMatchObject({ status: 400 })
  })
  it('duplicate: 201 with a new id; 409 profile_live while its browser runs', async () => {
    const p = await create('Src')
    expect(await api('POST', `/${p.id}/duplicate`, { name: 'Copy' })).toMatchObject({ status: 201, body: { name: 'Copy' } })
    rig.live.add(p.id)
    expect(await api('POST', `/${p.id}/duplicate`, { name: 'Copy2' })).toMatchObject({ status: 409, body: { error: 'profile_live' } })
  })
})

describe('cookie import per profile', () => {
  it('lands in the vault and the browser of the TARGET profile only', async () => {
    const a = await create('Acct A')
    const b = await create('Acct B')
    const r = await api('POST', `/${a.id}/cookies/import`, { format: 'storageState', content: storageState([{ name: 'sid', domain: 'app.example.com' }]) })
    expect(r).toMatchObject({ status: 200, body: { imported: 1, skipped: 0, domains: ['app.example.com'] } })
    expect(injected.map(([id]) => id)).toEqual([a.id])
    expect(rig.vault.listDomains(a.id)).toHaveLength(1)
    expect(rig.vault.listDomains(b.id)).toHaveLength(0)
    expect(rig.vault.listDomains('w1')).toHaveLength(0)
  })
  it('still skips Google source-bound sign-in cookies and reports them as skipped', async () => {
    const a = await create('Acct A')
    const r = await api('POST', `/${a.id}/cookies/import`, {
      format: 'storageState', content: storageState([{ name: 'SIDCC', domain: '.google.com' }, { name: 'ok', domain: 'example.com' }]),
    })
    expect(r).toMatchObject({ status: 200, body: { imported: 1, skipped: 1, reasons: ['google_source_bound'] } })
    expect(rig.vault.load(a.id).map((c) => c.domain)).toEqual(['example.com'])
    const only = await api('POST', `/${a.id}/cookies/import`, { format: 'storageState', content: storageState([{ name: 'AEC', domain: 'google.com' }]) })
    expect(only).toMatchObject({ status: 200, body: { imported: 0, skipped: 1 } })
  })
  it('preview then import by previewId works too; bad content maps to cookie_import_invalid; flag off to cookie_import_disabled', async () => {
    const a = await create('Acct A')
    const pre = await api('POST', `/${a.id}/cookies/preview`, { format: 'storageState', content: storageState([{ name: 'k', domain: 'x.com' }]) })
    const previewId = (pre!.body as { previewId: string }).previewId
    expect(await api('POST', `/${a.id}/cookies/import`, { previewId, domains: ['x.com'] })).toMatchObject({ status: 200, body: { imported: 1, domains: ['x.com'] } })
    expect(await api('POST', `/${a.id}/cookies/import`, { format: 'storageState', content: 'not json' })).toMatchObject({ status: 400, body: { error: 'cookie_import_invalid' } })
    importEnabled = false
    expect(await api('POST', `/${a.id}/cookies/import`, { format: 'netscape', content: '' })).toMatchObject({ status: 404, body: { error: 'cookie_import_disabled' } })
  })
  it('GET lists domains (no values); DELETE ?domain= removes one, none removes all', async () => {
    const a = await create('Acct A')
    rig.vault.save(a.id, [cookie('a.com', 'n', 'TOPSECRET'), cookie('b.com')])
    const got = await api('GET', `/${a.id}/cookies`)
    expect(JSON.stringify(got!.body)).not.toContain('TOPSECRET')
    expect((got!.body as { domains: unknown[] }).domains).toHaveLength(2)
    expect(await api('DELETE', `/${a.id}/cookies`, undefined, 'domain=a.com')).toEqual({ status: 204 })
    expect(rig.vault.listDomains(a.id).map((x) => x.domain)).toEqual(['b.com'])
    expect(await api('DELETE', `/${a.id}/cookies`)).toEqual({ status: 204 })
    expect(rig.vault.listDomains(a.id)).toEqual([])
  })
})

describe('export', () => {
  it('serves a download with Content-Disposition that imports back into another profile unchanged', async () => {
    const a = await create('Src')
    const dst = await create('Dst')
    rig.vault.save(a.id, [cookie('a.com', 'sid', 'v1')])
    const out = await api('GET', `/${a.id}/export`)
    expect(out!.status).toBe(200)
    expect(out!.headers?.['Content-Disposition']).toContain(`attachment; filename="webterm-cookies-${a.id}.json"`)
    const r = await api('POST', `/${dst.id}/cookies/import`, { format: 'storageState', content: JSON.stringify(out!.body) })
    expect(r).toMatchObject({ status: 200, body: { imported: 1 } })
    expect(rig.vault.load(dst.id)).toMatchObject([{ name: 'sid', value: 'v1', domain: 'a.com' }])
  })
})
