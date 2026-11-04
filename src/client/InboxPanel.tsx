// Operator inbox + blocking approval queue, rendered in the VS Code bottom panel. Standalone it
// owns a single-tab surface; `inboxChatPanel.tsx` is the two-tab Inbox/Chat mount. Props-driven:
// mount from App, open from Dock.
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
import { inboxApi, inboxErrorMessage, isAbortError, type InboxClient, type InboxItem, type InboxState } from './inboxApi'
import { CONFIRM_PHRASE, type ReviewState } from './inboxApprovalDialog'
import { InboxPanelActions, InboxPanelChrome, type InboxFilter } from './inboxPanelChrome'
import { InboxPanelDialog } from './inboxPanelDialog'
import { InboxPanelSections } from './inboxPanelSections'
import { InboxPanelSurface } from './inboxPanelSurface'
import { isPermissionItemId } from './InboxPanel.permission'
import { InboxItems } from './InboxPanel.items'
import {
  approvalRequest,
  resumeApprovalFor,
  resumeReviewState,
  reviewBlockedReason,
  useApprovedApprovals,
  useInboxCountPublisher,
  useInboxDialogKeys,
} from './inboxPanelModel'
import './inbox.css'

export { CONFIRM_PHRASE }

export interface InboxPanelProps {
  /** Default true. The Dock toggle owns this via `useInboxOpen` in App.tsx. */
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
  /** Render only the pane body: the combined Inbox/Chat shell owns the surface and tabs. */
  embedded?: boolean
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
  const [filter, setFilter] = useState<InboxFilter>('all')
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<ReadonlySet<InboxState>>(() => new Set())
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set())
  const [dialog, setDialog] = useState<ReviewState | null>(null)
  const [clock, setClock] = useState(0)

  const dialogRef = useRef<HTMLDivElement | null>(null)
  const dialogAbort = useRef<AbortController | null>(null)
  const seq = useRef(0)

  const items = useMemo(
    // Permission prompts render in `InboxItems` (unified inbox, F3-a) with their own buttons, never in the sections.
    () => (props.items ?? fetched ?? []).filter((item) => !hidden.has(item.id) && !isPermissionItemId(item.id)),
    [props.items, fetched, hidden]
  )

  // Resume path for approved-but-unconsumed consent. `ready` gates minting on a task row while the
  // first approved-list read is in flight (a duplicate approval is unrecoverable); a failed read
  // settles ready so the inbox never blocks.
  const { approved, ready: approvedReady } = useApprovedApprovals({
    enabled: open && props.items === undefined,
    client: clientRef,
    refreshKey,
  })

  const pending =
    dialog !== null &&
    (dialog.phase === 'requesting' || dialog.phase === 'deciding' || dialog.phase === 'consuming')

  /** Re-read the queue from the server: after a decision the server's list is what counts. */
  const refresh = useCallback(() => setRefreshKey((key) => key + 1), [])

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
        if (controller.signal.aborted) return
        setFetched(next)
        // The server list is the source of truth: drop optimistic hides so a row the server
        // still reports (e.g. a task whose approval was consumed) comes back instead of
        // staying invisible until a full reload.
        setHidden(new Set())
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

  // Keep the Dock badge truthful while this panel owns `/api/inbox` (see `inboxPanelModel`).
  useInboxCountPublisher(open, props.items === undefined && fetched === null ? null : items)

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

  const dialogOpen = dialog !== null
  // Countdown for the dialog's expiry label; the panel owns it so `beginReview` can re-sync it
  // synchronously when a new review opens.
  useEffect(() => {
    if (!dialogOpen) return
    setClock(nowRef.current())
    const id = setInterval(() => setClock(nowRef.current()), 1000)
    return () => clearInterval(id)
  }, [dialogOpen])
  // ---- focus trap + Escape ----------------------------------------------------------------
  useInboxDialogKeys({ open: dialogOpen, dialogRef, pending, onClose: closeDialog })
  // Panel-level Escape (only when no dialog owns the key).
  useEffect(() => {
    if (!open || props.embedded || !props.onClose) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || dialogRef.current) return
      props.onClose?.()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, props.embedded, props.onClose, dialogOpen])

  // ---- review flow ------------------------------------------------------------------------
  const beginReview = (queue: InboxItem[], index = 0): void => {
    const item = queue[index]
    // A task without a fence cannot be transitioned after approval; never mint that approval.
    if (!item || reviewBlockedReason(item) !== null) return
    // An approval for this task already exists: opening the dialog on it is the only safe move.
    // Minting another would duplicate consent and still leave the task unverified.
    const resume = resumeApprovalFor(item, approved)
    if (resume) {
      seq.current += 1
      dialogAbort.current?.abort()
      setClock(nowRef.current())
      setDialog(resumeReviewState(resume, queue, index))
      return
    }
    // A task review mints its approval on decide, so it must wait for the approved-list read:
    // minting before we know no unconsumed consent exists is the B4 duplicate-approval bug.
    if (item.kind === 'task' && !approvedReady) return
    const token = ++seq.current
    dialogAbort.current?.abort()
    const controller = new AbortController()
    dialogAbort.current = controller
    setClock(nowRef.current())
    // A task review has no server approval yet. Minting one here would leave a `pending` row in
    // `needs_you` for the whole TTL every time an operator merely opens and closes the dialog, so
    // the challenge is created when a decision is actually pressed (`decide`). Only an existing
    // approval is fetched on open, which never creates anything.
    const deferred = item.kind !== 'approval'
    setDialog({
      queue,
      index,
      challenge: null,
      deferred,
      phase: deferred ? 'ready' : 'requesting',
      error: null,
      checked: false,
      text: '',
      approvedDigest: null,
    })
    if (deferred) return
    clientRef.current
      .getApprovalChallenge(item.id, { signal: controller.signal })
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
    const item = current?.queue[current.index]
    if (!current || !item) return
    const token = seq.current
    setDialog((state) => (state ? { ...state, phase: 'deciding', error: null } : state))
    try {
      let challenge = current.challenge
      if (!challenge) {
        const controller = new AbortController()
        dialogAbort.current = controller
        challenge = await clientRef.current.requestApproval(approvalRequest(item), {
          signal: controller.signal,
        })
        if (seq.current !== token) return
        setDialog((state) => (state ? { ...state, challenge, deferred: false } : state))
      }
      const result = await clientRef.current.decideApproval({
        id: challenge.id,
        digest: challenge.digest,
        nonce: challenge.nonce,
        approve,
        ...(props.actor === undefined ? {} : { actor: props.actor }),
      })
      if (seq.current !== token) return
      // Either decision changes what the server lists (a rejected row leaves the queue; an
      // approved one may still be pending consume), so never trust the local copy after it.
      refresh()
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
    const item = current.queue[current.index]
    setDialog((state) => (state ? { ...state, phase: 'consuming', error: null } : state))
    try {
      await clientRef.current.consumeApproval({ id: challenge.id, digest })
      if (seq.current !== token) return
      // Only an approval row is identified by the approval id that was just spent. A task row's
      // id is the task id: hiding it would make the still-listed task vanish locally, then
      // reappear on reload. Its own lifecycle (server side) decides when it leaves the queue.
      if (item && item.kind === 'approval') setHidden((prev) => new Set(prev).add(item.id))
      refresh()
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
    const out: Record<InboxFilter, number> = { all: items.length, needs_you: 0, review: 0, broken: 0 }
    for (const item of items) out[item.state] += 1
    return out
  }, [items])

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return items.filter((item) => {
      if (filter !== 'all' && item.state !== filter) return false
      if (needle === '') return true
      return [item.title, item.kind, item.projectId, item.detail ?? '']
        .some((field) => field.toLowerCase().includes(needle))
    })
  }, [items, filter, query])

  const selectedItems = items.filter((item) => selected.has(item.id))

  if (!open) return null

  const body = (
    <>
      <InboxPanelChrome total={counts.all} loading={loading} filter={filter} counts={counts}
        query={query} matches={visible.length} onQuery={setQuery}
        listError={listError} selectedCount={selectedItems.length}
        onRefresh={() => setRefreshKey((key) => key + 1)} onFilter={setFilter}
        onReviewSelected={() => beginReview(selectedItems.filter((item) => reviewBlockedReason(item) === null))}
        onClearSelection={() => setSelected(new Set())} />

      {props.items === undefined && props.client === undefined && <InboxItems />}

      <InboxPanelSections uid={uid} filter={filter} visible={visible} collapsed={collapsed}
        selected={selected} approved={approved} approvedReady={approvedReady}
        onToggleSection={toggleSection} onSelectSection={selectSection} onToggleSelected={toggleSelected}
        onOpen={(item) => beginReview([item])} />

      {dialog && (
        <InboxPanelDialog state={dialog} clock={clock} pending={pending} uid={uid} dialogRef={dialogRef}
          onClose={closeDialog} onDecide={(approve) => void decide(approve)}
          onConsume={() => void consume()} onAdvance={advance}
          onRetry={() => beginReview(dialog.queue, dialog.index)}
          onChecked={(checked) => setDialog((state) => (state ? { ...state, checked } : state))}
          onText={(text) => setDialog((state) => (state ? { ...state, text } : state))} />
      )}
    </>
  )

  if (props.embedded) {
    return (
      <div className="inbox-panel inbox-panel--embedded">
        <div className="inbox-pane-actions" role="toolbar" aria-label="Inbox actions">
          <InboxPanelActions loading={loading}
            onRefresh={() => setRefreshKey((key) => key + 1)} />
        </div>
        {body}
      </div>
    )
  }

  return (
    <InboxPanelSurface
      className="inbox-panel"
      ariaLabel="Inbox"
      tabsLabel="Inbox tabs"
      tabs={[{
        id: 'inbox',
        label: 'Inbox',
        badge: counts.all,
        tooltip: 'Operator inbox and approvals',
        closable: props.onClose !== undefined,
      }]}
      activeId="inbox"
      onActivate={() => undefined}
      {...(props.onClose === undefined ? {} : { onClose: () => props.onClose?.(), onClosePanel: () => props.onClose?.() })}
      actions={<InboxPanelActions loading={loading}
        onRefresh={() => setRefreshKey((key) => key + 1)} />}
    >
      {body}
    </InboxPanelSurface>
  )
}
