// Fold state of the Sessions tree (JSON `{ key: collapsed }` in localStorage). Persisted because
// re-collapsing boards after every reload is work the user already did once.
import { useEffect, useState } from 'react'
import { parseCollapsed } from './sessionList'
import { CLOSED_KEY } from './SessionsPanel.tree'

const COLLAPSED_KEY = 'webterm.sessionsCollapsed'

function readCollapsed(): Record<string, boolean> {
  // localStorage access itself can throw (private mode, site data blocked); the panel works without it.
  try {
    return parseCollapsed(localStorage.getItem(COLLAPSED_KEY))
  } catch (err) {
    console.warn('[webterm] reading the Sessions fold state failed; starting unfolded', err instanceof Error ? err.message : err)
    return {}
  }
}

let warnedWrite = false

/** The fold map and its setter, saved on every change (this tab only when storage is refused). */
export function useCollapsedGroups() {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(readCollapsed)
  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify(collapsed))
    } catch (err) {
      // Once per page: a refused store fails on every fold, and the fold still works for this tab.
      if (!warnedWrite) console.warn('[webterm] saving the Sessions fold state failed; it lasts for this tab only', err instanceof Error ? err.message : err)
      warnedWrite = true
    }
  }, [collapsed])
  return [collapsed, setCollapsed] as const
}

/**
 * Fold state as the tree shows it. Filtering force-opens groups, but the saved preference stays
 * untouched: while a filter is active folds go to a session-only map (chevron still works, like the
 * VS Code Explorer) and clearing the filter restores the saved folds.
 */
export function useGroupFolds(filterActive: boolean) {
  const [collapsed, setCollapsed] = useCollapsedGroups()
  const [filterFolded, setFilterFolded] = useState<Record<string, boolean>>({})
  useEffect(() => {
    if (!filterActive) setFilterFolded((prev) => (Object.keys(prev).length === 0 ? prev : {}))
  }, [filterActive])
  const openOf = (key: string) => (filterActive ? !filterFolded[key] : !(collapsed[key] ?? key === CLOSED_KEY))
  // The ONE write path for a fold (click, keyboard observer, menu): an absolute value, and an
  // already-stored value returns the same object so repeats cause no re-render.
  const setFold = (key: string, open: boolean) => {
    const apply = (prev: Record<string, boolean>) => (prev[key] === !open ? prev : { ...prev, [key]: !open })
    return filterActive ? setFilterFolded(apply) : setCollapsed(apply)
  }
  const foldAll = (keys: string[]) =>
    (filterActive ? setFilterFolded : setCollapsed)((prev) => ({ ...prev, ...Object.fromEntries(keys.map((k) => [k, true])) }))
  return { openOf, setFold, foldAll }
}
