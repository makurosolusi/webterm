// Design Mode on/off state of one browser node, shared by the toolbar ⋯ menu (toggle) and the Design
// Mode bar (rendered only while on). Turning the overlay off on unmount keeps it out of the page.
import { useCallback, useEffect, useRef, useState } from 'react'
import { DESIGN_TEXT, designCall } from './DesignModeBar'

export interface DesignMode {
  on: boolean
  busy: boolean
  /** Last toggle failure (server message when there is one), cleared on the next toggle. */
  error: string | null
  toggle: () => Promise<void>
}

/** Design Mode state for `nodeId`; `toggle` asks the server and follows its answer. */
export function useDesignMode(nodeId: string): DesignMode {
  const [on, setOn] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const onRef = useRef(false)
  onRef.current = on

  useEffect(() => () => {
    if (onRef.current) designCall(nodeId, '', { on: false }).catch((e: unknown) => console.warn('design.off on unmount failed', e instanceof Error ? e.message : 'unknown'))
  }, [nodeId])

  const toggle = useCallback(async () => {
    setBusy(true); setError(null)
    try {
      const r = await designCall<{ on: boolean }>(nodeId, '', { on: !onRef.current })
      setOn(r.on)
    } catch (e) {
      setError(e instanceof Error ? e.message : DESIGN_TEXT.failed)
    } finally { setBusy(false) }
  }, [nodeId])

  return { on, busy, error, toggle }
}
