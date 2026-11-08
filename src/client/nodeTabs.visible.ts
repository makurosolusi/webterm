// "Show Node Tabs": whether the node tab strip sits above the canvas. One browser-wide choice, on by
// default, kept in localStorage (same as the Sessions panel's open state); read by the strip host,
// the View menu and the command palette through one store.
import { useSyncExternalStore } from 'react'

const KEY = 'webterm.nodeTabs'
const listeners = new Set<() => void>()

function read(): boolean {
  // Private mode / blocked site data throws on access; the default (shown) still works.
  try { return localStorage.getItem(KEY) !== '0' } catch { return true }
}

let shown = read()

export const nodeTabsShown = (): boolean => shown

export function setNodeTabsShown(next: boolean): void {
  if (next === shown) return
  shown = next
  try { localStorage.setItem(KEY, next ? '1' : '0') } catch { /* not persisted in private mode: this tab only */ }
  listeners.forEach((l) => l())
}

export const toggleNodeTabs = (): void => setNodeTabsShown(!shown)

/** Test hook: re-read the stored value (as a fresh page load would). */
export const reloadNodeTabsShown = (): void => { shown = read(); listeners.forEach((l) => l()) }

export const useNodeTabsShown = (): boolean =>
  useSyncExternalStore((l) => (listeners.add(l), () => void listeners.delete(l)), nodeTabsShown)
