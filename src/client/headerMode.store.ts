// Header mode: how much of the app header is on screen. `full` is the two-row header (title bar +
// workspace tabs), `compact` one 35px row, `hidden` no row (a pointer push at the top edge reveals
// it, `useHeaderReveal`). One per-device preference in `localStorage` (the same server serves a laptop,
// native and a phone, and the wanted chrome differs); it renders correctly without storage.
// Design: docs/decisions/header-rail-layout.md.
import { useSyncExternalStore } from 'react'

export type HeaderMode = 'full' | 'compact' | 'hidden'

export const HEADER_MODES: readonly HeaderMode[] = ['full', 'compact', 'hidden']
/** Compact for everyone: the space gain is the point (generous defaults). */
export const DEFAULT_HEADER_MODE: HeaderMode = 'compact'
export const HEADER_MODE_KEY = 'webterm.headerMode'
/** Set once the "header is now compact" notice was shown (or the user chose a mode themselves). */
export const HEADER_NOTICE_KEY = 'webterm.headerMode.noticed'

const isHeaderMode = (v: unknown): v is HeaderMode => HEADER_MODES.includes(v as HeaderMode)

interface Stored {
  mode: HeaderMode
  /** A valid value is in storage: the user (or the notice's action) picked it. */
  chosen: boolean
  noticed: boolean
}

function readStored(): Stored {
  try {
    const raw = localStorage.getItem(HEADER_MODE_KEY)
    return { mode: isHeaderMode(raw) ? raw : DEFAULT_HEADER_MODE, chosen: isHeaderMode(raw), noticed: localStorage.getItem(HEADER_NOTICE_KEY) === '1' }
  } catch {
    // Storage unavailable (private mode, blocked site data): the default, for this tab only.
    return { mode: DEFAULT_HEADER_MODE, chosen: false, noticed: false }
  }
}

let state: Stored = readStored()
/** The mode to go back to when the chord leaves Hidden; memory only (a reload starts at the stored one). */
let lastVisible: HeaderMode = state.mode === 'hidden' ? DEFAULT_HEADER_MODE : state.mode
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
  if (mode !== 'hidden') lastVisible = mode
  state = { mode, chosen: true, noticed: true }
  persist(HEADER_MODE_KEY, mode)
  persist(HEADER_NOTICE_KEY, '1')
  emit()
}

/** `Mod+Shift+H`: Hidden <-> the last visible mode. */
export function toggleHeaderHidden(): void {
  setHeaderMode(state.mode === 'hidden' ? lastVisible : 'hidden')
}

/** The one-time notice is due: nothing was ever chosen and it was not shown yet. */
export const headerNoticeDue = (): boolean => !state.chosen && !state.noticed

/** The notice was shown; it never returns. */
export function markHeaderNoticed(): void {
  state = { ...state, noticed: true }
  persist(HEADER_NOTICE_KEY, '1')
  emit()
}

/** Test seam: reload from storage. */
export function reloadHeaderModeFromStorage(): void {
  state = readStored()
  lastVisible = state.mode === 'hidden' ? DEFAULT_HEADER_MODE : state.mode
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
 * The mode actually drawn (derived, never persisted). Full while booting or with no workspace (the
 * header's `+` is the only door then); Hidden falls back to Compact without a pointer.
 */
export function effectiveHeaderMode({ stored, hydrated, workspaceCount, touch }: EffectiveInput): HeaderMode {
  if (!hydrated || workspaceCount === 0) return 'full'
  if (stored === 'hidden' && touch) return 'compact'
  return stored
}

/** `effectiveHeaderMode` for the running app. */
export function useEffectiveHeaderMode(hydrated: boolean, workspaceCount: number): HeaderMode {
  const stored = useHeaderMode()
  const touch = useSyncExternalStore(subscribeHover, noHover)
  return effectiveHeaderMode({ stored, hydrated, workspaceCount, touch })
}
