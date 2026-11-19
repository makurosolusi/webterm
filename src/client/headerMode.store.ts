// Header mode: how much of the workspace tab row is on screen. `tabs` is the one 35px row of workspace tabs
// (the only header there is: no title bar), `hidden` removes the row (a pointer push at the top edge reveals it,
// `useHeaderReveal`). One per-device preference in `localStorage` (the same server serves a laptop, native and a
// phone, and the wanted chrome differs); it renders correctly without storage.
// Design: docs/decisions/header-rail-layout.md.
import { useSyncExternalStore } from 'react'

export type HeaderMode = 'tabs' | 'hidden'

export const HEADER_MODES: readonly HeaderMode[] = ['tabs', 'hidden']
/** Tabs for everyone: workspaces stay one click away; Hidden is the choice of whoever wants every pixel. */
export const DEFAULT_HEADER_MODE: HeaderMode = 'tabs'
export const HEADER_MODE_KEY = 'webterm.headerMode'
/** Set once the "header changed" notice was shown (a stored Full / Compact value was carried over). */
export const HEADER_NOTICE_KEY = 'webterm.headerMode.reworkNoticed'
/**
 * Values written by the Full / Compact header (before the rework). They carry over as `tabs`: both showed the
 * workspaces and the search in the header, and the tab row is the closest thing that still exists.
 * legacy: remove after 0.11.0 (every stored value has been rewritten by then).
 */
const LEGACY_MODES: readonly string[] = ['full', 'compact']

const isHeaderMode = (v: unknown): v is HeaderMode => HEADER_MODES.includes(v as HeaderMode)
const isLegacyMode = (v: unknown): boolean => typeof v === 'string' && LEGACY_MODES.includes(v)

interface Stored {
  mode: HeaderMode
  /** A value of the old Full / Compact header is in storage and the user has not been told yet. */
  migrated: boolean
}

function readStored(): Stored {
  try {
    const raw = localStorage.getItem(HEADER_MODE_KEY)
    return { mode: isHeaderMode(raw) ? raw : DEFAULT_HEADER_MODE, migrated: isLegacyMode(raw) && localStorage.getItem(HEADER_NOTICE_KEY) !== '1' }
  } catch {
    // Storage unavailable (private mode, blocked site data): the default, for this tab only.
    return { mode: DEFAULT_HEADER_MODE, migrated: false }
  }
}

let state: Stored = readStored()
const listeners = new Set<() => void>()
const emit = (): void => listeners.forEach((l) => l())

function persist(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Private mode: the choice lasts for this tab only.
  }
}

/** Current stored mode (not the effective one: see `effectiveHeaderMode`). */
export const getHeaderMode = (): HeaderMode => state.mode

/** Choose a mode. An explicit choice also retires the one-time notice. */
export function setHeaderMode(mode: HeaderMode): void {
  if (!isHeaderMode(mode)) return
  state = { mode, migrated: false }
  persist(HEADER_MODE_KEY, mode)
  persist(HEADER_NOTICE_KEY, '1')
  emit()
}

/** `Mod+Shift+H`: Hidden <-> Tabs. */
export function toggleHeaderHidden(): void {
  setHeaderMode(state.mode === 'hidden' ? 'tabs' : 'hidden')
}

/** The one-time notice is due: a stored Full / Compact value was carried over to Tabs and nobody said so yet. */
export const headerNoticeDue = (): boolean => state.migrated

/** The notice was shown; the stored value is rewritten to the new name and the notice never returns. */
export function markHeaderNoticed(): void {
  state = { ...state, migrated: false }
  persist(HEADER_MODE_KEY, state.mode)
  persist(HEADER_NOTICE_KEY, '1')
  emit()
}

/** Test seam: reload from storage. */
export function reloadHeaderModeFromStorage(): void {
  state = readStored()
  emit()
}

const subscribe = (l: () => void): (() => void) => {
  listeners.add(l)
  return () => { listeners.delete(l) }
}

export const useHeaderMode = (): HeaderMode => useSyncExternalStore(subscribe, getHeaderMode)

/** Touch devices: no hover, so nothing to reveal Hidden with. */
const NO_HOVER_QUERY = '(hover: none)'

const subscribeHover = (l: () => void): (() => void) => {
  const mq = typeof window.matchMedia === 'function' ? window.matchMedia(NO_HOVER_QUERY) : null
  mq?.addEventListener('change', l)
  return () => mq?.removeEventListener('change', l)
}
const noHover = (): boolean => typeof window.matchMedia === 'function' && window.matchMedia(NO_HOVER_QUERY).matches

export interface EffectiveInput {
  stored: HeaderMode
  hydrated: boolean
  workspaceCount: number
  /** `(hover: none)` */
  touch: boolean
}

/**
 * The mode actually drawn (derived, never persisted). Tabs while booting or with no workspace (the row's `+`
 * and menu button are the only doors then); Hidden falls back to Tabs without a pointer.
 */
export function effectiveHeaderMode({ stored, hydrated, workspaceCount, touch }: EffectiveInput): HeaderMode {
  if (!hydrated || workspaceCount === 0) return 'tabs'
  if (stored === 'hidden' && touch) return 'tabs'
  return stored
}

/** `effectiveHeaderMode` for the running app. */
export function useEffectiveHeaderMode(hydrated: boolean, workspaceCount: number): HeaderMode {
  const stored = useHeaderMode()
  const touch = useSyncExternalStore(subscribeHover, noHover)
  return effectiveHeaderMode({ stored, hydrated, workspaceCount, touch })
}
