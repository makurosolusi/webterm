// The user's start-page shortcuts (per client, localStorage, like `browser.recent.ts`). Never stored = the defaults
// from `browser.startpage.data.ts`; once the user adds, edits or removes one, the whole list is saved.
import { parseBrowserUrl } from '../shared/browser.url'
import { SHORTCUTS, type Shortcut } from './browser.startpage.data'
import { randomId } from './randomId'

export const SHORTCUTS_STORAGE_KEY = 'webterm.browser.shortcuts'
/** Chrome's NTP caps its custom tiles too; keeps the grid and storage small. */
export const SHORTCUTS_MAX = 20
const LABEL_MAX = 60

const isShortcut = (x: unknown): x is Shortcut => {
  const o = x as Record<string, unknown> | null
  return !!o && typeof o.id === 'string' && typeof o.label === 'string' && typeof o.url === 'string'
}

/** Saved list (re-validated: a hand-edited entry with another scheme never reaches a tile); missing/broken -> defaults. */
export function loadShortcuts(): Shortcut[] {
  try {
    const raw = localStorage.getItem(SHORTCUTS_STORAGE_KEY)
    if (raw === null) return [...SHORTCUTS]
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return [...SHORTCUTS]
    return parsed.filter(isShortcut).filter((s) => parseBrowserUrl(s.url).ok).slice(0, SHORTCUTS_MAX)
  } catch (e) {
    console.warn('browser.shortcuts load failed', e instanceof Error ? e.name : 'unknown')
    return [...SHORTCUTS]
  }
}

function save(list: Shortcut[]): Shortcut[] {
  try {
    localStorage.setItem(SHORTCUTS_STORAGE_KEY, JSON.stringify(list))
  } catch (e) {
    // Quota / private mode: the list still applies for this session, it just does not persist.
    console.warn('browser.shortcuts save failed', e instanceof Error ? e.name : 'unknown')
  }
  return list
}

/** Normalized shortcut fields, or null when the URL is not an allowed http(s) address. Empty name = the host. */
export function cleanShortcut(label: string, rawUrl: string): { label: string; url: string } | null {
  const raw = rawUrl.trim()
  const p = parseBrowserUrl(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`)
  if (!p.ok) return null
  return { label: label.trim().slice(0, LABEL_MAX) || p.host, url: p.url }
}

/** Adds (no `id`) or replaces (with `id`) one shortcut; returns the new list, unchanged when the URL is rejected. */
export function putShortcut(list: Shortcut[], label: string, url: string, id?: string): Shortcut[] {
  const c = cleanShortcut(label, url)
  if (!c) return list
  if (id) return save(list.map((s) => (s.id === id ? { ...s, ...c } : s)))
  if (list.length >= SHORTCUTS_MAX) return list
  return save([...list, { id: randomId(), ...c }])
}

export function removeShortcut(list: Shortcut[], id: string): Shortcut[] {
  return save(list.filter((s) => s.id !== id))
}
