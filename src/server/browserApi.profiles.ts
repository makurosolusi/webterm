// `/api/browser/profiles/*`: list, create, rename/recolor, delete, duplicate, export and per-profile cookie import.
// Auth is the `/api/*` gate in index.ts (UI session + Origin; node tokens have no path to this prefix), so every
// route here is human-only; agents reach the same service through Central tools and the `open` verb. Cookie
// values never appear in a response (except `export`, an explicit human download) or a log line.
import { isBrowserProfileId } from '../shared/browser.profile'
import type { ProfileErrorCode, ProfileImportResp } from '../shared/browser.profile'
import { cookieRoute, fail, readObject } from './browserApi.cookies'
import type { BrowserApiResult, CookieApiDeps } from './browserApi.cookies'
import { duplicateProfile, exportCookies, removeProfile } from './browser/browser.profiles.ops'
import type { ProfileOpsDeps } from './browser/browser.profiles.ops'
import type { ProfileResult, ProfilesService } from './browser/browser.profiles.service'
import type { AccountsService } from './browser/browser.accounts.service'
import type { CookiePreviewResp } from '../shared/browser.contract'

export interface ProfileApiDeps {
  profiles: ProfilesService
  ops: ProfileOpsDeps
  cookies: CookieApiDeps
  /** Account check (absent in tests that do not need it). */
  accounts?: AccountsService
}

const STATUS: Record<ProfileErrorCode, number> = {
  profile_not_found: 404, profile_name_taken: 409, profile_name_invalid: 400, profile_in_use: 409, profile_live: 409,
  profile_default: 409, bad_request: 400, cookie_import_disabled: 404, cookie_import_invalid: 400, cookie_import_empty: 400,
}
const failCode = (code: ProfileErrorCode, extra: object = {}): BrowserApiResult => fail(STATUS[code], code, extra)
const reply = <T>(r: ProfileResult<T>, status: number, map: (v: T) => unknown = (v) => v): BrowserApiResult =>
  r.ok ? { status, ...(status === 204 ? {} : { body: map(r.value) }) } : failCode(r.code)

type Body = () => Promise<string>

/** Cookie import: `{format, content}` in one step (preview + take every importable domain), or `{previewId, domains}` after a preview. */
async function importCookies(id: string, body: Body, d: ProfileApiDeps): Promise<BrowserApiResult> {
  if (!d.cookies.cookieImportEnabled()) return failCode('cookie_import_disabled')
  const text = await body()
  const read = await readObject(() => Promise.resolve(text))
  if (!read.ok) return read.result
  if (read.value.previewId !== undefined) {
    const r = await cookieRoute('POST', id, ['commit'], () => Promise.resolve(text), d.cookies)
    return r?.status === 200 ? { status: 200, body: { ...(r.body as object), skipped: 0, reasons: [] } } : (r ?? fail(404, 'not_found'))
  }
  const pre = await cookieRoute('POST', id, ['preview'], () => Promise.resolve(text), d.cookies)
  if (!pre || pre.status !== 200) {
    const e = (pre?.body as { reason?: string } | undefined)?.reason
    if (pre?.status === 400) return failCode(e === 'no_cookies' ? 'cookie_import_empty' : 'cookie_import_invalid', e ? { reason: e } : {})
    return pre ?? fail(404, 'not_found')
  }
  const preview = pre.body as CookiePreviewResp
  const skipped = preview.googleSkipped ?? 0
  const reasons = skipped > 0 ? ['google_source_bound'] : []
  if (preview.domains.length === 0) return { status: 200, body: { imported: 0, skipped, reasons, domains: [] } satisfies ProfileImportResp }
  const commit = JSON.stringify({ previewId: preview.previewId, domains: preview.domains.map((x) => x.domain) })
  const done = await cookieRoute('POST', id, ['commit'], () => Promise.resolve(commit), d.cookies)
  if (done?.status !== 200) return done ?? fail(404, 'not_found')
  return { status: 200, body: { ...(done.body as object), skipped, reasons } }
}

async function cookies(method: string, id: string, rest: string[], search: URLSearchParams, body: Body, d: ProfileApiDeps): Promise<BrowserApiResult | null> {
  const [head, ...tail] = rest
  if (head === undefined && method === 'GET') return cookieRoute('GET', id, ['domains'], body, d.cookies)
  if (head === undefined && method === 'DELETE') {
    const domain = search.get('domain')
    return cookieRoute('DELETE', id, domain === null ? [] : [domain], body, d.cookies)
  }
  if (tail.length > 0) return null
  if (head === 'preview' && method === 'POST') return cookieRoute('POST', id, ['preview'], body, d.cookies)
  if (head === 'import' && method === 'POST') return importCookies(id, body, d)
  return null
}

/** Routes under `/api/browser/profiles`; `rest` = segments after `profiles`. null = not a profile route. */
export async function profileRoute(method: string, rest: string[], search: URLSearchParams, body: Body, d: ProfileApiDeps): Promise<BrowserApiResult | null> {
  const [id, kind, ...more] = rest
  if (id === undefined) {
    if (method === 'GET') return { status: 200, body: { profiles: d.profiles.list(search.get('workspaceId') ?? undefined), ...(d.accounts ? { accountsEnabled: d.accounts.enabled() } : {}) } }
    if (method !== 'POST') return null
    const read = await readObject(body)
    if (!read.ok) return read.result
    const { name, color, shade, workspaceId } = read.value
    return reply(d.profiles.create({ name: name as string, color: color as string | undefined, shade: shade as string | undefined, workspaceId: workspaceId as string | undefined }), 201)
  }
  if (!isBrowserProfileId(id)) return fail(400, 'bad_request')
  if (!d.profiles.deps.store.get(id)) return failCode('profile_not_found')
  if (kind === undefined) {
    if (method === 'PUT') {
      const read = await readObject(body)
      if (!read.ok) return read.result
      const { name, color, shade } = read.value
      return reply(d.profiles.update(id, { name: name as string | undefined, color: color as string | undefined, shade: shade as string | undefined }), 200)
    }
    if (method === 'DELETE') return reply(removeProfile(d.ops, id), 204)
    return null
  }
  if (kind === 'cookies') return cookies(method, id, more, search, body, d)
  if (kind === 'accounts' && more[0] === 'refresh' && more.length === 1 && method === 'POST') {
    // `?popover=1`: the popover merely opened, so the 10 minute TTL applies; the Refresh button sends none and only the 15 s floor applies.
    return { status: 200, body: { accounts: (await d.accounts?.refresh(id, { respectTtl: search.get('popover') === '1' })) ?? [] } }
  }
  if (more.length > 0) return null
  if (kind === 'duplicate' && method === 'POST') {
    const read = await readObject(body)
    return read.ok ? reply(duplicateProfile(d.ops, id, read.value.name), 201) : read.result
  }
  if (kind === 'export' && method === 'GET') {
    const r = exportCookies(d.ops, id)
    if (!r.ok) return failCode(r.code)
    return { status: 200, body: JSON.parse(r.value), headers: { 'Content-Disposition': `attachment; filename="webterm-cookies-${id}.json"`, 'Cache-Control': 'no-store' } }
  }
  return null
}
