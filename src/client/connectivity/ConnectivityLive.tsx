// Always-mounted polite live region for the Claude link. Speaks at most once per ANNOUNCE_GAP_MS; a burst of
// changes collapses into the latest sentence. Empty text (item gone) clears the region without speaking.
import { useEffect, useRef, useState } from 'react'

export const ANNOUNCE_GAP_MS = 3_000

export function ConnectivityLive({ text }: { text: string }) {
  const [spoken, setSpoken] = useState('')
  const last = useRef(-Infinity)

  useEffect(() => {
    if (text === spoken) return
    const speak = () => { last.current = Date.now(); setSpoken(text) }
    if (!text) { setSpoken(''); return }
    const wait = last.current + ANNOUNCE_GAP_MS - Date.now()
    if (wait <= 0) { speak(); return }
    const t = setTimeout(speak, wait)
    return () => clearTimeout(t)
  }, [text, spoken])

  return <span className="sr-only" role="status" aria-live="polite" data-slot="connectivity-live">{spoken}</span>
}
