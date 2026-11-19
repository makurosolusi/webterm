// Where the dialog imports into: a workspace browser (`/api/browser/:ws/cookies`) or a named profile (`/profiles/:id/cookies`).
// Both speak preview -> commit with `{previewId, domains}`; the dialog only sees this interface.
import type { CookieCommitReq, CookieCommitResp, CookieDomainInfo, CookiePreviewReq, CookiePreviewResp } from '../../shared/browser.contract'
import { clearCookies, commitCookies, listCookieDomains, previewCookies } from '../browser.api'
import { clearProfileCookies, importProfileCookies, listProfileCookies, previewProfileCookies } from '../browserProfileApi'

export interface CookieTarget {
  /** Shown as "Importing into <name>". */
  name: string
  list(): Promise<CookieDomainInfo[]>
  preview(req: CookiePreviewReq): Promise<CookiePreviewResp>
  commit(req: CookieCommitReq): Promise<CookieCommitResp>
  /** One domain, or everything when omitted. */
  clear(domain?: string): Promise<void>
}

/** The browser of one workspace (the toolbar menu's target). */
export const workspaceTarget = (workspaceId: string, name: string): CookieTarget => ({
  name,
  list: async () => (await listCookieDomains(workspaceId)).domains,
  preview: (req) => previewCookies(workspaceId, req),
  commit: (req) => commitCookies(workspaceId, req),
  clear: (domain) => clearCookies(workspaceId, domain),
})

/** One browser profile (Settings > Browser). */
export const profileTarget = (profileId: string, name: string): CookieTarget => ({
  name,
  list: async () => (await listProfileCookies(profileId)).domains,
  preview: (req) => previewProfileCookies(profileId, req),
  commit: async (req) => {
    const r = await importProfileCookies(profileId, req)
    return { imported: r.imported, domains: r.domains }
  },
  clear: (domain) => clearProfileCookies(profileId, domain),
})
