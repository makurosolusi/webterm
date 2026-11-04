// Async feeds of the omnibox: the workspace file list (fetched once per open, like QuickOpen.tsx)
// and paged text search with cancellation (VS Code quick search: every keystroke cancels the
// previous search; closing the box cancels the running one).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { search } from './fsClient'
import { cancelGrepRemote, grepPage, type GrepMatch } from './QuickOpen.grep'
import { randomId } from './randomId'

/** Debounce between the last keystroke and the search request. */
export const SEARCH_DEBOUNCE_MS = 200
export const SEARCH_TEXT = {
  fallback: 'ripgrep (rg) is not installed: using the slower built-in search.',
  failed: 'Search failed: ',
  stopped: 'Search stopped before the end.',
  searching: 'Searching…',
  noFiles: 'Could not list files: ',
}

export function useWorkspaceFiles(root: string | undefined, wanted: boolean): { files: string[]; error?: string } {
  const [state, setState] = useState<{ files: string[]; error?: string }>({ files: [] })
  useEffect(() => {
    if (!root || !wanted) return
    let alive = true
    void search(root, '*').then((r) => {
      if (alive) setState(r.ok ? { files: r.files } : { files: [], error: r.error })
    })
    return () => { alive = false }
  }, [root, wanted])
  return state
}

export interface TextSearch {
  matches: GrepMatch[]
  hasMore: boolean
  busy: boolean
  notice?: string
  loadMore: () => void
}

/** Paged search for `needle` under `root`; empty needle = idle. */
export function useTextSearch(root: string | undefined, needle: string, active: boolean): TextSearch {
  const searchId = useMemo(randomId, [])
  const [matches, setMatches] = useState<GrepMatch[]>([])
  const [next, setNext] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string>()
  const abort = useRef<AbortController | null>(null)

  const fetchPage = useCallback((offset: number) => {
    if (!root) return
    abort.current?.abort()
    const ctl = new AbortController()
    abort.current = ctl
    setBusy(true)
    void grepPage(root, needle, offset, searchId, ctl.signal).then((r) => {
      if (ctl.signal.aborted) return
      abort.current = null
      setBusy(false)
      if (!r.ok) { setNotice(SEARCH_TEXT.failed + r.error); return }
      setMatches((prev) => (offset === 0 ? r.matches : [...prev, ...r.matches]))
      setNext(r.nextOffset)
      setNotice(r.engine === 'fallback' ? SEARCH_TEXT.fallback : r.cancelled ? SEARCH_TEXT.stopped : undefined)
    })
  }, [root, needle, searchId])

  useEffect(() => {
    setMatches([])
    setNext(null)
    setNotice(undefined)
    // A page still in flight for the old query: stop it on both ends (the next request with the
    // same id would supersede it too, but only after the debounce, or never if the box empties).
    if (abort.current) { abort.current.abort(); cancelGrepRemote(searchId) }
    abort.current = null
    if (!active || !needle) { setBusy(false); return }
    const t = setTimeout(() => fetchPage(0), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [active, needle, fetchPage, searchId])

  // Closing the box: abort the fetch and tell the server to kill rg.
  useEffect(() => () => {
    if (abort.current) { abort.current.abort(); cancelGrepRemote(searchId) } // only set while a page is in flight
  }, [searchId])

  return { matches, hasMore: next !== null, busy, notice, loadMore: () => { if (next !== null) fetchPage(next) } }
}
