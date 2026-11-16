// The status-bar view of the Claude link, with display hysteresis: a blip under DEGRADED_SHOW_MS is never shown,
// "Back online" dismisses itself, and a flapping link keeps ONE item on screen instead of mounting/unmounting it.
import { useEffect, useRef, useState } from 'react'
import { useNetRaw } from './connectivity.store'
import { buildView, type ConnectivityView, type Shown } from './connectivity.view'

export const DEGRADED_SHOW_MS = 5_000
export const RECOVERED_SHOW_MS = 6_000

export function useConnectivity(): ConnectivityView | null {
  const raw = useNetRaw()
  const [shown, setShown] = useState<Shown | null>(null)
  const shownRef = useRef<Shown | null>(null)

  useEffect(() => {
    const show = (s: Shown | null) => { shownRef.current = s; setShown(s) }
    // unknown / loading: we do not know, so we say nothing and accuse nothing.
    if (raw.phase !== 'known') { if (shownRef.current) show(null); return }
    const { net } = raw
    const prev = shownRef.current
    if (net.state === 'offline') { show({ kind: 'offline', net }); return }
    if (net.state === 'degraded') {
      if (prev && prev.kind !== 'recovered') { show({ kind: 'degraded', net }); return }
      const t = setTimeout(() => show({ kind: 'degraded', net }), DEGRADED_SHOW_MS)
      return () => clearTimeout(t)
    }
    // online: only something that was on screen earns a "Back online".
    if (prev && prev.kind !== 'recovered') show({ kind: 'recovered', net: prev.net })
    if (!shownRef.current) return
    const t = setTimeout(() => show(null), RECOVERED_SHOW_MS)
    return () => clearTimeout(t)
  }, [raw])

  return shown ? buildView(shown, Date.now()) : null
}
