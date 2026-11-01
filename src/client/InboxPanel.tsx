// Operator inbox + blocking approval queue. Props-driven: mount from App, open from Dock.
//
//   const [open, setOpen] = useInboxOpen()
//   <InboxPanel open={open} onClose={() => setOpen(false)} />
//
// With no `items` prop it loads `GET /api/inbox` (and on Refresh / pollMs). Consent rules:
// nothing is approved by typing "yes" or a single click. `inboxApprovalDialog.tsx` requires the
// irreversible-action checkbox AND the exact phrase APPROVE. Digest/nonce always come from the
// server challenge; this file never hashes anything. Consume is offered only after the decision
// came back `approved`. Reject is a first-class decision, not "close and forget".
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { AlertTriangle, ChevronDown, ChevronRight, RefreshCw, ShieldAlert, X } from 'lucide-react'
import { inboxApi, inboxErrorMessage, isAbortError, type InboxClient, type InboxItem, type InboxState } from './inboxApi'
import { CONFIRM_PHRASE, InboxApprovalDialog, type ReviewState } from './inboxApprovalDialog'
import {
  FOCUSABLE,
  SECTION_LABEL,
  SECTION_ORDER,
  formatAge,
  useInboxOpen,
} from './inboxPanelModel'
import './inbox.css'

export { CONFIRM_PHRASE }

export interface InboxPanelProps {
  /** Default true. The Dock toggle owns this in `useInboxOpen` below. */
  open?: boolean
  onClose?: () => void
  /** Preloaded list. When present the panel never fetches; the integrator is the source. */
  items?: InboxItem[]
  /** API implementation. Must be referentially stable (module-level default is). */
  client?: InboxClient
  /** Clock used for expiry countdowns; injected in tests. Defaults to Date.now. */
  now?: () => number
  /** Auto-refresh interval in ms. 0/undefined = off. */
  pollMs?: number
  /** Recorded on approve/reject decisions when the server wants an actor id. */
  actor?: string
}

export default function InboxPanel(props: InboxPanelProps) {
  const open = props.open ?? true
  const uid = useId()
  // Refs, not effect deps: an integrator passing an inline client/clock must not restart fetches.
  const clientRef = useRef<InboxClient>(props.client ?? inboxApi)
  clientRef.current = props.client ?? inboxApi
  const nowRef = useRef<() => number>(props.now ?? Date.now)
  nowRef.current = props.now ?? Date.now

  const [fetched, setFetched] = useState<InboxItem[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [listError, setListError] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [filter, setFilter] = useState<'all' | InboxState>('all')
  const [collapsed, setCollapsed] = useState<ReadonlySet<InboxState>>(() => new Set())
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set())
  const [dialog, setDialog] = useState<ReviewState | null>(null)
  const [clock, setClock] = useState(0)

  const dialogRef = useRef<HTMLDivElement | null>(null)
  const dialogAbort = useRef<AbortController | null>(null)
  const seq = useRef(0)

  const items = useMemo(
    () => (props.items ?? fetched ?? []).filter((item) => !hidden.has(item.id)),
    [props.items, fetched, hidden]
  )

  const pending =
    dialog !== null &&
    (dialog.phase === 'requesting' || dialog.phase === 'deciding' || dialog.phase === 'consuming')
  const pendingRef = useRef(pending)
  pendingRef.current = pending

  const closeDialog = useCallback(() => {
    seq.current += 1
    dialogAbort.current?.abort()
    setDialog(null)
  }, [])

  // ---- data -------------------------------------------------------------------------------
  useEffect(() => {
    if (!open || props.items !== undefined) return
    const controller = new AbortController()
    setLoading(true)
    setListError(null)
    clientRef.current
      .listInbox({ signal: controller.signal })
      .then((next) => {
        if (!controller.signal.aborted) setFetched(next)
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || isAbortError(error)) return
        setListError(inboxErrorMessage(error))
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [open, props.items, refreshKey])

  useEffect(() => {
    const ms = props.pollMs ?? 0
    if (!open || ms <= 0 || props.items !== undefined) return
    const id = setInterval(() => setRefreshKey((key) => key + 1), ms)
    return () => clearInterval(id)
  }, [open, props.items, props.pollMs])
  // Abort an in-flight challenge when the panel itself unmounts.
  useEffect(() => () => dialogAbort.current?.abort(), [])

  // Drop selections whose item disappeared (consumed or refreshed away).
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev
      const ids = new Set(items.map((item) => item.id))
      const next = new Set([...prev].filter((id) => ids.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [items])

  // ---- countdown --------------------------------------------------------------------------
  const dialogOpen = dialog !== null
  useEffect(() => {
    if (!dialogOpen) return
    setClock(nowRef.current())
    const id = setInterval(() => setClock(nowRef.current()), 1000)
    return () => clearInterval(id)
  }, [dialogOpen])
  // ---- focus trap + Escape ----------------------------------------------------------------
  useEffect(() => {
    if (!dialogOpen) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const node = dialogRef.current
    const focusables = (): HTMLElement[] =>
      node ? Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)) : []
    focusables()[0]?.focus()
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        if (!pendingRef.current) closeDialog()
        return
      }
      if (event.key !== 'Tab' || !node) return
      const list = focusables()
      if (list.length === 0) {
        event.preventDefault()
        return
      }
      const first = list[0]
      const last = list[list.length - 1]
      const active = document.activeElement
      const outside = !node.contains(active)
      if (event.shiftKey && (active === first || outside)) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (active === last || outside)) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      if (previous?.isConnected) previous.focus()
    }
  }, [dialogOpen, closeDialog])
  // Panel-level Escape (only when no dialog owns the key).
  useEffect(() => {
    if (!open || !props.onClose) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || dialogRef.current) return
      props.onClose?.()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, props.onClose, dialogOpen])

  // ---- review flow ------------------------------------------------------------------------
  const beginReview = (queue: InboxItem[], index = 0): void => {
    const item = queue[index]
    if (!item) return
    const token = ++seq.current
    dialogAbort.current?.abort()
    const controller = new AbortController()
    dialogAbort.current = controller
    setClock(nowRef.current())
    setDialog({ queue, index, challenge: null, phase: 'requesting', error: null, checked: false, text: '', approvedDigest: null })
    clientRef.current
      .requestApproval(
        {
          kind: item.kind,
          projectId: item.projectId,
          request: { itemId: item.id, title: item.title, detail: item.detail ?? null },
        },
        { signal: controller.signal }
      )
      .then((challenge) => {
        if (seq.current !== token) return
        setDialog((current) => (current ? { ...current, challenge, phase: 'ready' } : current))
      })
      .catch((error: unknown) => {
        if (seq.current !== token || isAbortError(error)) return
        setDialog((current) => (current ? { ...current, phase: 'ready', error: inboxErrorMessage(error) } : current))
      })
  }

  const advance = (): void => {
    const current = dialog
    if (!current) return
    if (current.index + 1 < current.queue.length) beginReview(current.queue, current.index + 1)
    else closeDialog()
  }

  const decide = async (approve: boolean): Promise<void> => {
    const current = dialog
    const challenge = current?.challenge
    if (!current || !challenge) return
    const token = seq.current
    setDialog((state) => (state ? { ...state, phase: 'deciding', error: null } : state))
    try {
      const result = await clientRef.current.decideApproval({
        id: challenge.id,
        digest: challenge.digest,
        nonce: challenge.nonce,
        approve,
        ...(props.actor === undefined ? {} : { actor: props.actor }),
      })
      if (seq.current !== token) return
      if (!approve) {
        setDialog((state) => (state ? { ...state, phase: 'rejected', error: null } : state))
        return
      }
      if (result.status !== 'approved') {
        setDialog((state) =>
          state
            ? { ...state, phase: 'ready', error: `Approval was not granted (${result.status}).`, checked: false, text: '' }
            : state
        )
        return
      }
      setDialog((state) => (state ? { ...state, phase: 'approved', approvedDigest: challenge.digest, error: null } : state))
    } catch (error) {
      if (seq.current !== token || isAbortError(error)) return
      // Clear the confirmation so a retry is a fresh, explicit act.
      setDialog((state) =>
        state ? { ...state, phase: 'ready', error: inboxErrorMessage(error), checked: false, text: '' } : state
      )
    }
  }

  const consume = async (): Promise<void> => {
    const current = dialog
    const challenge = current?.challenge
    const digest = current?.approvedDigest
    if (!current || !challenge || !digest) return
    const token = seq.current
    const itemId = current.queue[current.index]?.id
    setDialog((state) => (state ? { ...state, phase: 'consuming', error: null } : state))
    try {
      await clientRef.current.consumeApproval({ id: challenge.id, digest })
      if (seq.current !== token) return
      if (itemId) setHidden((prev) => new Set(prev).add(itemId))
      setDialog((state) => (state ? { ...state, phase: 'consumed', error: null } : state))
    } catch (error) {
      if (seq.current !== token || isAbortError(error)) return
      setDialog((state) => (state ? { ...state, phase: 'approved', error: inboxErrorMessage(error) } : state))
    }
  }

  const toggleSection = (state: InboxState): void => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(state)) next.delete(state)
      else next.add(state)
      return next
    })
  }

  const toggleSelected = (id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const selectSection = (rows: InboxItem[], select: boolean): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      for (const row of rows) {
        if (select) next.add(row.id)
        else next.delete(row.id)
      }
      return next
    })
  }

  // ---- derived ----------------------------------------------------------------------------
  const counts = useMemo(() => {
    const out: Record<'all' | InboxState, number> = { all: items.length, needs_you: 0, review: 0, broken: 0 }
    for (const item of items) out[item.state] += 1
    return out
  }, [items])

  const visible = useMemo(
    () => (filter === 'all' ? items : items.filter((item) => item.state === filter)),
    [items, filter]
  )

  const challenge = dialog?.challenge ?? null
  const remaining = challenge ? challenge.expiresAt - clock : 0
  const expired = challenge !== null && remaining <= 0
  const canApprove = !pending && !expired && dialog !== null && dialog.checked && dialog.text === CONFIRM_PHRASE
  const selectedItems = items.filter((item) => selected.has(item.id))

  if (!open) return null

  return (
    <aside className="inbox-panel" aria-label="Inbox" aria-labelledby={`${uid}-title`}>
      <header className="inbox-head">
        <ShieldAlert size={15} aria-hidden="true" />
        <h2 className="inbox-title" id={`${uid}-title`}>Inbox</h2>
        <span className="inbox-total" aria-label={`${counts.all} items`}>{counts.all}</span>
        <span className="inbox-grow" />
        <button type="button" className="inbox-icon-btn" aria-label="Refresh inbox" title="Refresh inbox"
          disabled={loading} onClick={() => setRefreshKey((key) => key + 1)}>
          <RefreshCw size={14} aria-hidden="true" />
        </button>
        {props.onClose && (
          <button type="button" className="inbox-icon-btn" aria-label="Close inbox" onClick={props.onClose}>
            <X size={15} aria-hidden="true" />
          </button>
        )}
      </header>

      <div className="inbox-filters" role="group" aria-label="Filter inbox">
        {(['all', ...SECTION_ORDER] as const).map((key) => (
          <button key={key} type="button" className={`inbox-chip${filter === key ? ' is-active' : ''}`}
            aria-pressed={filter === key} onClick={() => setFilter(key)}>
            {key === 'all' ? 'All' : SECTION_LABEL[key]}
            <span className="inbox-count">{counts[key]}</span>
          </button>
        ))}
      </div>

      {selectedItems.length > 0 && (
        <div className="inbox-bulk" role="toolbar" aria-label="Group actions">
          <span aria-live="polite">{selectedItems.length} selected</span>
          <button type="button" className="inbox-btn inbox-btn--ghost" onClick={() => beginReview(selectedItems)}>
            Review selected
          </button>
          <button type="button" className="inbox-btn inbox-btn--ghost" onClick={() => setSelected(new Set())}>
            Clear
          </button>
        </div>
      )}

      {listError && (
        <div className="inbox-error" role="alert">
          <AlertTriangle size={14} aria-hidden="true" />
          <span>{listError}</span>
          <button type="button" className="inbox-btn inbox-btn--ghost" onClick={() => setRefreshKey((key) => key + 1)}>
            Retry
          </button>
        </div>
      )}

      {loading && items.length === 0 && !listError && (
        <p className="inbox-status" role="status">Loading inbox…</p>
      )}

      {!loading && !listError && items.length === 0 && (
        <p className="inbox-status" role="status">Inbox is clear.</p>
      )}

      <div className="inbox-sections">
        {SECTION_ORDER.map((state) => {
          const rows = visible.filter((item) => item.state === state)
          if (filter === 'all' && rows.length === 0) return null
          if (filter !== 'all' && filter !== state) return null
          const isCollapsed = collapsed.has(state)
          const bodyId = `${uid}-section-${state}`
          const allSelected = rows.length > 0 && rows.every((row) => selected.has(row.id))
          return (
            <section className="inbox-section" key={state} aria-labelledby={`${uid}-section-head-${state}`}>
              <header className="inbox-section__head">
                <input type="checkbox" className="inbox-check"
                  aria-label={`Select all in ${SECTION_LABEL[state]}`}
                  checked={allSelected} disabled={rows.length === 0}
                  onChange={(event) => selectSection(rows, event.target.checked)} />
                <button type="button" className="inbox-section__toggle" id={`${uid}-section-head-${state}`}
                  aria-expanded={!isCollapsed} aria-controls={bodyId} onClick={() => toggleSection(state)}>
                  {isCollapsed
                    ? <ChevronRight size={13} aria-hidden="true" />
                    : <ChevronDown size={13} aria-hidden="true" />}
                  <span>{SECTION_LABEL[state]}</span>
                  <span className="inbox-count">{rows.length}</span>
                </button>
              </header>
              {!isCollapsed && (
                <div id={bodyId}>
                  {rows.length === 0 ? (
                    <p className="inbox-section__empty">Nothing in this section.</p>
                  ) : (
                    <ul className="inbox-list">
                      {rows.map((item) => (
                        <li className="inbox-item" key={item.id}>
                          <input type="checkbox" className="inbox-check" aria-label={`Select ${item.title}`}
                            checked={selected.has(item.id)} onChange={() => toggleSelected(item.id)} />
                          <div className="inbox-item__body">
                            <div className="inbox-item__top">
                              <span className={`inbox-state inbox-state--${item.state}`}>{SECTION_LABEL[item.state]}</span>
                              <span className="inbox-item__title">{item.title}</span>
                              <span className="inbox-item__age" title={`${item.ageMs} ms ago`}>{formatAge(item.ageMs)} ago</span>
                            </div>
                            <div className="inbox-item__meta">
                              <span className="inbox-item__kind">{item.kind}</span>
                              <span aria-hidden="true">·</span>
                              <span className="inbox-item__project">{item.projectId}</span>
                            </div>
                            {item.detail && <p className="inbox-item__detail">{item.detail}</p>}
                            <div className="inbox-item__actions">
                              <button type="button" className="inbox-btn inbox-btn--ghost"
                                aria-label={`Review ${item.title}`} onClick={() => beginReview([item])}>
                                Review
                              </button>
                            </div>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </section>
          )
        })}
      </div>

      {dialog && (
        <InboxApprovalDialog
          state={dialog}
          challenge={challenge}
          remainingMs={remaining}
          expired={expired}
          pending={pending}
          canApprove={canApprove}
          uid={uid}
          dialogRef={dialogRef}
          onClose={closeDialog}
          onDecide={(approve) => void decide(approve)}
          onConsume={() => void consume()}
          onAdvance={advance}
          onRetry={() => beginReview(dialog.queue, dialog.index)}
          onChecked={(checked) => setDialog((state) => (state ? { ...state, checked } : state))}
          onText={(text) => setDialog((state) => (state ? { ...state, text } : state))}
        />
      )}
    </aside>
  )
}
