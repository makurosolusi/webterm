// "Who is signed in" for one profile on the client: the accounts the list carries, the refresh call, and its state.
// A refresh answer is shown at once; the next list reload (server frame `browserProfiles`) takes over again.
import { useCallback, useEffect, useRef, useState } from 'react'
import { accountsRefreshPath, validateAccounts } from '../shared/browser.accounts'
import type { ProfileAccount } from '../shared/browser.accounts'
import type { BrowserProfile } from '../shared/browser.profile'
import { BrowserApiError } from './browser.api'

/** POST the refresh route; `popover` = the menu merely opened (the server keeps its 10 minute TTL). */
export async function refreshProfileAccounts(profileId: string, popover = false): Promise<ProfileAccount[]> {
  const url = `${accountsRefreshPath(profileId)}${popover ? '?popover=1' : ''}`
  const res = await fetch(url, { method: 'POST', headers: { Accept: 'application/json' } })
  if (!res.ok) throw new BrowserApiError(`POST ${url} failed (${res.status})`, res.status, `http_${res.status}`)
  const body = (await res.json()) as { accounts?: unknown }
  return validateAccounts(body.accounts)
}

export interface ProfileAccountsView {
  accounts: ProfileAccount[]
  loading: boolean
  /** The last refresh failed (network / server); the old accounts stay listed. */
  failed: boolean
  refresh(popover?: boolean): Promise<ProfileAccount[]>
  /** Check without waiting or throwing: a failure only sets `failed`. `popover` keeps the server's TTL; false forces (the menu's Refresh). */
  check(popover: boolean): void
}

export function useProfileAccounts(profile: Pick<BrowserProfile, 'id' | 'accounts'> | undefined): ProfileAccountsView {
  const id = profile?.id
  const listed = profile?.accounts
  const [fresh, setFresh] = useState<ProfileAccount[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => { setFresh(null) }, [listed, id])

  const run = useCallback(async (popover: boolean): Promise<{ ok: true; accounts: ProfileAccount[] } | { ok: false; error: unknown }> => {
    if (!id) return { ok: true, accounts: [] }
    setLoading(true); setFailed(false)
    try {
      const out = await refreshProfileAccounts(id, popover)
      if (alive.current) setFresh(out)
      return { ok: true, accounts: out }
    } catch (error) {
      if (alive.current) setFailed(true)
      return { ok: false, error }
    } finally {
      if (alive.current) setLoading(false)
    }
  }, [id])
  /** The Refresh button: resolves with the accounts, rejects with the cause (the button reports it). */
  const refresh = useCallback(async (popover = false): Promise<ProfileAccount[]> => {
    const r = await run(popover)
    if (!r.ok) throw r.error
    return r.accounts
  }, [run])
  const check = useCallback((popover: boolean): void => { void run(popover) }, [run])

  return { accounts: fresh ?? listed ?? [], loading, failed, refresh, check }
}
