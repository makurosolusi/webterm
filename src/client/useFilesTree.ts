// Tree state of a Files node: which folders are expanded (persisted as node data `expanded`, paths
// relative to cwd) and their lazily listed children. 
// `TreeEntry` (lazy list when a dir is open with nothing loaded; a refresh invalidates every open
// subtree) and `state/explorer.ts` (expanded set per owner, persisted).
import { useEffect, useMemo, useRef, useState } from 'react'
import { useReactFlow } from '@xyflow/react'
import type { FileMeta } from '../shared/fsContract'
import type { ViewOpts } from '../shared/workspace'
import { childPath } from './fileBrowse'
import { flattenTree, type TreeRow } from './filesTree'
import { applyView } from './filesView'
import { fetchEntries } from './useFilesListing'

interface Args {
  id: string
  cwd: string
  /** Bumped by refresh/watch: every expanded folder is listed again. */
  version: number
  view: ViewOpts
  /** Root listing (from `useFilesListing`). */
  root: readonly FileMeta[]
  /** Persisted `expanded` node data, read once on mount. */
  initial?: readonly string[]
}

/** Loaded children per folder, tagged with the listing scope + version they were fetched for. */
type Kids = { scope: string; map: ReadonlyMap<string, { version: number; list: FileMeta[] }> }
const NO_KIDS: Kids['map'] = new Map()

export function useFilesTree({ id, cwd, version, view, root, initial }: Args) {
  const rf = useReactFlow()
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(initial ?? []))
  const [kids, setKids] = useState<Kids>({ scope: '', map: NO_KIDS })
  const withMeta = view.sortKey !== 'name'
  const scope = `${cwd}\0${withMeta}`
  const map = kids.scope === scope ? kids.map : NO_KIDS
  const scopeRef = useRef(scope)
  scopeRef.current = scope
  const inflight = useRef(new Set<string>())

  const commit = (next: ReadonlySet<string>) => {
    setExpanded(next)
    // ponytail: paths of folders deleted outside the node linger here until collapsed/reset; prune on load if it grows.
    rf.updateNodeData(id, { expanded: [...next] })
  }

  // Expanded paths are relative to cwd: a different folder (breadcrumb) starts fully collapsed.
  const lastCwd = useRef(cwd)
  useEffect(() => {
    if (lastCwd.current === cwd) return
    lastCwd.current = cwd
    commit(new Set())
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs on cwd change only
  }, [cwd])

  const rows = useMemo((): TreeRow[] => {
    const children = new Map([...map].map(([rel, v]) => [rel, v.list]))
    return flattenTree(root, children, expanded, (level) => applyView(level, view))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `view` split into fields so object identity does not recompute
  }, [root, map, expanded, view.hidden, view.sortKey, view.sortDir])

  // Lazy listing: every VISIBLE open folder whose children are missing or older than `version`.
  // Stale children stay shown until the fresh list lands (no collapse flicker on refresh).
  useEffect(() => {
    for (const r of rows) {
      if (!r.open || map.get(r.rel)?.version === version) continue
      const key = `${scope}\0${version}\0${r.rel}`
      if (inflight.current.has(key)) continue
      inflight.current.add(key)
      void fetchEntries(childPath(cwd, r.rel), withMeta).then((list) => {
        inflight.current.delete(key)
        if (scopeRef.current !== scope) return
        setKids((k) => {
          const next = new Map(k.scope === scope ? k.map : NO_KIDS)
          const had = next.get(r.rel)
          if (had && had.version > version) return k
          next.set(r.rel, { version, list })
          return { scope, map: next }
        })
      }, () => {
        // `list` is fail-open by contract, so a rejection is a transport fault: the folder stays
        // unloaded (shown with no children) and the next refresh lists it again.
        inflight.current.delete(key)
      })
    }
  }, [rows, map, version, scope, cwd, withMeta])

  const setOpen = (rel: string, open: boolean) => {
    if (expanded.has(rel) === open) return
    const next = new Set(expanded)
    if (open) next.add(rel)
    else next.delete(rel)
    commit(next)
  }

  return {
    rows,
    expanded,
    setOpen,
    toggle: (rel: string) => setOpen(rel, !expanded.has(rel)),
    collapseAll: () => { if (expanded.size) commit(new Set()) },
  }
}
