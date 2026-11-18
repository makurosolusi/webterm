// REST client for /api/browser/profiles/* plus a list hook that follows the server's `browserProfiles` frame.
// No UI here. Same credential as api.ts (the `wt_ui` session cookie); bodies are never echoed into errors.
import { useCallback, useEffect, useState } from 'react'
import { BROWSER_REST_PREFIX } from '../shared/browser.contract'
import type { CookieDomainInfo, CookiePreviewReq, CookiePreviewResp } from '../shared/browser.contract'
import type {
  BrowserProfile, ProfileCreateReq, ProfileImportResp, ProfileListResp, ProfileUpdateReq,
} from '../shared/browser.profile'
import { BrowserApiError } from './browser.api'

const PROFILES = `${BROWSER_REST_PREFIX}/profiles`
const seg = encodeURIComponent

async function errorCode(res: Response): Promise<string> {
  try {
    const body: unknown = await res.json()
    const e = body && typeof body === 'object' ? (body as { error?: unknown }).error : undefined
    if (typeof e === 'string' && e !== '') return e
  } catch {
    // Non-JSON error body: the status alone is the signal.
  }
  return `http_${res.status}`
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(url, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  if (!res.ok) {
    const code = await errorCode(res)
    throw new BrowserApiError(`${method} ${url} failed (${res.status} ${code})`, res.status, code)
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T)
}

/** Profiles visible from a board (global + that board's Default), or all when `workspaceId` is omitted. */
export const listBrowserProfiles = (workspaceId?: string) =>
  call<ProfileListResp>('GET', `${PROFILES}${workspaceId === undefined ? '' : `?workspaceId=${seg(workspaceId)}`}`)
/** New profile; color/shade left out = a random hue no other profile uses. */
export const createBrowserProfile = (req: ProfileCreateReq) => call<BrowserProfile>('POST', PROFILES, req)
export const updateBrowserProfile = (id: string, req: ProfileUpdateReq) => call<BrowserProfile>('PUT', `${PROFILES}/${seg(id)}`, req)
/** 409 `profile_in_use` while a node uses it; 409 `profile_default` for a board's Default profile. */
export const deleteBrowserProfile = (id: string) => call<void>('DELETE', `${PROFILES}/${seg(id)}`)
/** 409 `profile_live` while its browser is running. */
export const duplicateBrowserProfile = (id: string, name: string) => call<BrowserProfile>('POST', `${PROFILES}/${seg(id)}/duplicate`, { name })

export const listProfileCookies = (id: string) => call<{ domains: CookieDomainInfo[] }>('GET', `${PROFILES}/${seg(id)}/cookies`)
/** Remove stored cookies of one domain, or all when `domain` is omitted. */
export const clearProfileCookies = (id: string, domain?: string) =>
  call<void>('DELETE', `${PROFILES}/${seg(id)}/cookies${domain === undefined ? '' : `?domain=${seg(domain)}`}`)
export const previewProfileCookies = (id: string, req: CookiePreviewReq) => call<CookiePreviewResp>('POST', `${PROFILES}/${seg(id)}/cookies/preview`, req)
/** One step: `{format, content}` imports every importable domain; `{previewId, domains}` imports the chosen ones of a preview. */
export const importProfileCookies = (id: string, req: CookiePreviewReq | { previewId: string; domains: string[] }) =>
  call<ProfileImportResp>('POST', `${PROFILES}/${seg(id)}/cookies/import`, req)
/** Cookie export (storageState JSON text, re-importable); the caller saves it as a file. */
export async function exportProfileCookies(id: string): Promise<string> {
  const res = await fetch(`${PROFILES}/${seg(id)}/export`, { method: 'GET' })
  if (!res.ok) throw new BrowserApiError(`GET ${PROFILES}/${seg(id)}/export failed (${res.status})`, res.status, await errorCode(res))
  return res.text()
}
/** Move a browser node to another profile; its page reopens on the last URL in that profile's browser. */
export const setNodeBrowserProfile = (nodeId: string, profileId: string) =>
  call<{ profileId: string }>('POST', `${BROWSER_REST_PREFIX}/${seg(nodeId)}/profile`, { profileId })

/**
 * Profile list that reloads on the server's `browserProfiles` frame. `subscribe` is the window's frame listener
 * (ws.listeners `subscribeBrowserProfiles`, added by the UI wave); without it the list loads once and on `reload()`.
 */
export function useBrowserProfiles(opts: { workspaceId?: string; subscribe?: (cb: () => void) => () => void } = {}): {
  profiles: BrowserProfile[]; error: BrowserApiError | null; reload: () => void
  /** True once a load answered (ok or failed): tells "still loading" from "empty". */
  loaded: boolean
} {
  const { workspaceId, subscribe } = opts
  const [profiles, setProfiles] = useState<BrowserProfile[]>([])
  const [error, setError] = useState<BrowserApiError | null>(null)
  const [tick, setTick] = useState(0)
  const [loaded, setLoaded] = useState(false)
  const reload = useCallback(() => setTick((n) => n + 1), [])
  useEffect(() => (subscribe ? subscribe(reload) : undefined), [subscribe, reload])
  useEffect(() => {
    let live = true
    listBrowserProfiles(workspaceId).then(
      (r) => { if (live) { setProfiles(r.profiles); setError(null); setLoaded(true) } },
      (e: unknown) => { if (live) { setError(e instanceof BrowserApiError ? e : new BrowserApiError(String(e), 0, 'network')); setLoaded(true) } },
    )
    return () => { live = false }
  }, [workspaceId, tick])
  return { profiles, error, reload, loaded }
}
