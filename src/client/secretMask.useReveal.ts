// React binding for the secret-mask reveal state: per-value/all reveal, auto-hide, and
// hide-on-leave (window blur, tab hidden, Escape). Listeners exist only while something is revealed.
import { useCallback, useEffect, useState } from 'react'
import {
  countMasked, createAutoHide, hasReveal, hiddenState, hideAll as hideAllState, revealAll as revealAllState,
  revealIndex as revealIndexState, type MaskScan, type RevealState,
} from './secretMask.reveal'

export interface UseSecretRevealOptions { scan: MaskScan; autoHideSec: number; enabled: boolean }
export interface SecretReveal {
  state: RevealState
  revealIndex: (i: number) => void
  revealAll: () => void
  hideAll: () => void
  masked: number
}

export function useSecretReveal({ scan, autoHideSec, enabled }: UseSecretRevealOptions): SecretReveal {
  // The state is tagged with the scan it belongs to: a new scan (text changed) reads as hidden
  // immediately, with no stale-render frame.
  const [held, setHeld] = useState<{ scan: MaskScan; rev: RevealState }>({ scan, rev: hiddenState() })
  const state = enabled && held.scan === scan ? held.rev : hiddenState()
  const revealed = hasReveal(state)

  const update = useCallback((fn: (s: RevealState) => RevealState) => {
    setHeld((h) => ({ scan, rev: fn(h.scan === scan ? h.rev : hiddenState()) }))
  }, [scan])
  const hideAll = useCallback(() => setHeld({ scan, rev: hiddenState() }), [scan])
  const revealIndex = useCallback((i: number) => update((s) => revealIndexState(s, i)), [update])
  const revealAll = useCallback(() => update(revealAllState), [update])

  useEffect(() => {
    if (!revealed) return
    // Re-runs on every state change, so each reveal action restarts the idle timer.
    const timer = createAutoHide({ seconds: autoHideSec, onHide: hideAll })
    timer.touch()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') hideAll() }
    const onVisibility = () => { if (document.visibilityState === 'hidden') hideAll() }
    window.addEventListener('blur', hideAll)
    window.addEventListener('keydown', onKey)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      timer.stop()
      window.removeEventListener('blur', hideAll)
      window.removeEventListener('keydown', onKey)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [revealed, state, autoHideSec, hideAll])

  return { state, revealIndex, revealAll, hideAll, masked: countMasked(scan, state) }
}
