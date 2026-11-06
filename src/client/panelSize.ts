// One resizable VS Code part (bottom panel height, secondary side bar width): the size lives in
// module state, persists under its localStorage key, and is mirrored to a CSS custom property on
// <html> once the user picks one (absent = the stylesheet's default). `null` means "default".
import { useEffect, useSyncExternalStore } from 'react'

/** Sash keyboard steps in px: plain arrow, and arrow with Shift. */
export const SASH_STEP = 10
export const SASH_STEP_LARGE = 50

export interface PanelSizeState {
  /** User-chosen px size, or null for the default. */
  size: number | null
  maximized: boolean
}

export interface PanelSizeSpec {
  /** localStorage key of the user-chosen size. */
  key: string
  /** Custom property on <html> that mirrors a user-chosen size. */
  cssVar: string
  min: number
  /** Largest size as a share of `viewport()`. */
  maxRatio: number
  /** Size when the user never chose one. */
  defaultSize: () => number
  /** Window extent along the resize axis (innerHeight for a panel, innerWidth for a side bar). */
  viewport: () => number
  /** Sash keys that grow / shrink the part (the sash sits on the edge facing the canvas). */
  growKey: string
  shrinkKey: string
}

export interface PanelSize {
  readonly min: number
  max: () => number
  clamp: (size: number) => number
  /** The px size currently shown, resolving the default and maximize. */
  current: () => number
  /** Set (and persist) a new size; leaves maximized mode. */
  set: (size: number) => void
  /** Toggle maximize; does not touch storage. */
  toggleMaximized: () => void
  /** Forget the stored size (double-click on the sash restores the default). */
  reset: () => void
  /** Test seam: reset module state to what storage holds. */
  reload: () => void
  /** Size after a sash keyboard key, or null when the key is not a sash key. */
  afterKey: (key: string, shift: boolean, from: number) => number | null
  /** Subscribe to the size and mirror it to `spec.cssVar`. */
  use: () => PanelSizeState
}

/** Build the size store of one resizable part. */
export function createPanelSize(spec: PanelSizeSpec): PanelSize {
  const readStored = (): number | null => {
    try {
      const raw = window.localStorage.getItem(spec.key)
      const value = raw === null ? Number.NaN : Number(raw)
      return Number.isFinite(value) && value > 0 ? value : null
    } catch {
      return null
    }
  }
  const persist = (size: number | null): void => {
    try {
      if (size === null) window.localStorage.removeItem(spec.key)
      else window.localStorage.setItem(spec.key, String(Math.round(size)))
    } catch {
      // Storage can be unavailable (private mode); the size then lasts for the session only.
    }
  }

  let state: PanelSizeState = { size: readStored(), maximized: false }
  const listeners = new Set<() => void>()
  const emit = (next: PanelSizeState): void => {
    state = next
    listeners.forEach((listener) => listener())
  }
  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  const max = (): number => Math.max(spec.min, Math.floor(spec.viewport() * spec.maxRatio))
  const clamp = (size: number): number => Math.min(max(), Math.max(spec.min, Math.round(size)))
  const current = (): number => (state.maximized ? max() : clamp(state.size ?? spec.defaultSize()))

  return {
    min: spec.min,
    max,
    clamp,
    current,
    set: (size) => {
      const next = clamp(size)
      persist(next)
      emit({ size: next, maximized: false })
    },
    toggleMaximized: () => emit({ ...state, maximized: !state.maximized }),
    reset: () => {
      persist(null)
      emit({ size: null, maximized: false })
    },
    reload: () => emit({ size: readStored(), maximized: false }),
    afterKey: (key, shift, from) => {
      const step = shift ? SASH_STEP_LARGE : SASH_STEP
      if (key === spec.growKey) return clamp(from + step)
      if (key === spec.shrinkKey) return clamp(from - step)
      if (key === 'Home') return spec.min
      if (key === 'End') return max()
      return null
    },
    use: () => {
      const now = useSyncExternalStore(subscribe, () => state)
      useEffect(() => {
        const root = document.documentElement.style
        if (now.size === null && !now.maximized) root.removeProperty(spec.cssVar)
        else root.setProperty(spec.cssVar, `${current()}px`)
      }, [now])
      return now
    },
  }
}
