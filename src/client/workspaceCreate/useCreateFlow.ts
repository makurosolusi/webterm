// Shared submit flow of Clone repository and New project: ask the server first (preflight), stop on
// "already cloned", "name taken" or a wrong-place warning until the user picks, then run the create
// call and keep the dialog open on a success state (Reveal / Copy path). The server still refuses a
// non-empty target and the data dir on its own; this only explains it before it happens.
import { useCallback, useRef, useState } from 'react'
import { preflight, type Preflight } from './workspaceCreate.api'

export type Notice =
  | { kind: 'existing'; pre: Preflight }
  | { kind: 'taken'; pre: Preflight }
  | { kind: 'blocked'; pre: Preflight }
  | { kind: 'warn'; pre: Preflight }

/** What the user already waved through for the current inputs. */
export interface Ack { existing?: boolean; warnings?: boolean }

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** First thing the user must decide about, or null when the create may run. */
export function noticeFor(pre: Preflight, ack: Ack): Notice | null {
  if (pre.existing && !ack.existing) return { kind: 'existing', pre }
  if (pre.taken) return { kind: 'taken', pre }
  if (pre.warnings.some((w) => w.blocking)) return { kind: 'blocked', pre }
  if (pre.warnings.length > 0 && !ack.warnings) return { kind: 'warn', pre }
  return null
}

export interface CreateFlow {
  busy: boolean
  error: string
  notice: Notice | null
  /** Path made by the last successful run: the dialog shows its success state. */
  created: string | null
  ack: Ack
  submit(ack?: Ack): Promise<void>
  /** Inputs changed: earlier answers no longer apply. `keepExisting`: only the folder moved, the
   *  "clone again anyway" answer about the URL still stands. */
  reset(keepExisting?: boolean): void
}

export function useCreateFlow(input: { parent: string; name: string; url?: string }, run: () => Promise<string>, onCreated: (path: string) => void, quiet: (e: unknown) => boolean = () => false): CreateFlow {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState<Notice | null>(null)
  const [created, setCreated] = useState<string | null>(null)
  const [ack, setAck] = useState<Ack>({})

  const reset = useCallback((keepExisting = false) => {
    setNotice(null)
    setAck((a) => (keepExisting && a.existing ? { existing: true } : {}))
    setError('')
  }, [])

  // A ref, not `busy`: two submits in the same tick (Enter + click) both see busy=false.
  const inFlight = useRef(false)
  const submit = async (more: Ack = {}): Promise<void> => {
    if (inFlight.current) return
    inFlight.current = true
    const nextAck = { ...ack, ...more }
    setAck(nextAck)
    setBusy(true)
    setError('')
    setNotice(null)
    try {
      const pre = await preflight({ parent: input.parent, name: input.name, ...(input.url ? { url: input.url } : {}) })
      const n = noticeFor(pre, nextAck)
      if (n) { setNotice(n); return }
      const path = await run()
      setCreated(path)
      onCreated(path)
    } catch (e) {
      if (!quiet(e)) setError(errText(e))
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return { busy, error, notice, created, ack, submit, reset }
}
