// Pinned rail ("Show labels"): the rail is 220px wide with a name beside every item. A per-device
// preference in `localStorage` (try/catch: storage can be blocked), applied as `data-rail-labels` on
// <html> so `dock.rail.css` can move the one width token that the grid and every floating panel read.
import { useEffect, useSyncExternalStore } from 'react'

export const RAIL_LABELS_KEY = 'webterm.railLabels'
export const RAIL_LABELS_ATTR = 'data-rail-labels'

function read(): boolean {
  try { return localStorage.getItem(RAIL_LABELS_KEY) === 'on' } catch { return false } // storage blocked: default collapsed
}

let pinned = read()
const listeners = new Set<() => void>()

export const getRailLabels = (): boolean => pinned

export function setRailLabels(next: boolean): void {
  pinned = next
  try { localStorage.setItem(RAIL_LABELS_KEY, next ? 'on' : 'off') } catch { /* storage blocked: the choice lasts for this page only */ }
  for (const l of listeners) l()
}

export const toggleRailLabels = (): void => setRailLabels(!pinned)

/** Test seam: reload from storage. */
export function reloadRailLabelsFromStorage(): void {
  pinned = read()
  for (const l of listeners) l()
}

const subscribe = (l: () => void): (() => void) => {
  listeners.add(l)
  return () => { listeners.delete(l) }
}

export const useRailLabels = (): boolean => useSyncExternalStore(subscribe, getRailLabels)

/** Mirrors the preference onto <html> while the rail is mounted. */
export function useRailLabelsAttribute(): void {
  const on = useRailLabels()
  useEffect(() => {
    const root = document.documentElement
    if (on) root.setAttribute(RAIL_LABELS_ATTR, 'on')
    else root.removeAttribute(RAIL_LABELS_ATTR)
    return () => root.removeAttribute(RAIL_LABELS_ATTR)
  }, [on])
}
