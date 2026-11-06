// Client side of Find in Files (`/api/fs/grep`, server `src/server/fsGrep.ts`). Same FsResult
// contract as fsClient.ts verbs: never throws; network/JSON failures become `EIO`. Cancellation is
// two-sided, like VS Code's search cancellation token: the fetch is aborted AND the server is told
// to kill rg (`grep-cancel`), since an aborted HTTP request does not stop the process by itself.
import { fsFail, type FsResult } from '../shared/fsContract'

export interface GrepMatch { file: string; line: number; col: number; text: string }
export interface GrepPage { matches: GrepMatch[]; nextOffset: number | null; engine: 'rg' | 'fallback'; cancelled: boolean }

/** Matches fetched per page; the server clamps to its own maximum. */
export const GREP_PAGE_SIZE = 100

function url(verb: string, params: Record<string, string>): string {
  return `/api/fs/${verb}?${new URLSearchParams(params).toString()}`
}

/** One page of matches for `q` under `root`. `searchId` lets a newer page supersede this one server-side. */
export async function grepPage(root: string, q: string, offset: number, searchId: string, signal?: AbortSignal): Promise<FsResult<GrepPage>> {
  try {
    const res = await fetch(url('grep', { root, q, offset: String(offset), limit: String(GREP_PAGE_SIZE), searchId }), { signal })
    return (await res.json()) as FsResult<GrepPage>
  } catch (e) {
    if (signal?.aborted) return { ok: true, matches: [], nextOffset: null, engine: 'rg', cancelled: true }
    return fsFail('EIO', `grep "${q}": ${e instanceof Error ? e.message : String(e)}`)
  }
}

/** Ask the server to stop the search running under `searchId`. Best effort: failure only logs. */
export function cancelGrepRemote(searchId: string): void {
  void fetch(url('grep-cancel', { searchId }), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ searchId }) })
    .catch((e: unknown) => console.warn('grep cancel failed', e instanceof Error ? e.message : String(e)))
}
