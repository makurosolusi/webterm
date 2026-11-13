// Fold state of the Sessions tree (JSON `{ key: collapsed }` in localStorage). Persisted because
// re-collapsing boards after every reload is work the user already did once.
import { useEffect, useState } from 'react'
import { parseCollapsed } from './sessionList'

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
