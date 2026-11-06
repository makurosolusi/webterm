// Unified inbox items (F3-a) at the top of the Inbox: notify / question / review / gate, each with
// the actions the server allows (LangChain Agent Inbox accept / edit / respond / ignore, plus deny,
// snooze and, for Claude permission prompts only, "Always allow"). A one-line impact (what happens,
// tier, rewindable or not) sits under every gate so approving is never blind. Gates are held while a
// Claude hook waits, so the list polls on its own. Other ledger approvals (task reviews, Central
// gates) keep their APPROVE-phrase dialog in the sections below and are not repeated here.
// The server pages the list (agent-211-C8); "Load more" adds a page, and each poll re-reads them all.
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { IconTooltip } from '@/components/ui/icon-button'
import { Checkbox } from '@/components/ui/checkbox'
import { Textarea } from '@/components/ui/textarea'
import { APPROVAL_PATH, inboxErrorMessage, isAbortError } from './inboxApi'
import { InboxPanelError } from './inboxPanelChrome'
import { request } from './inboxTransport'

export const INBOX_ITEMS_PATH = `${APPROVAL_PATH}/inbox`
const POLL_MS = 2000
const HOUR_MS = 3_600_000
const PERMISSION_KIND = 'agent.permission'

type Kind = 'notify' | 'question' | 'review' | 'gate'
type ActionType = 'approve' | 'deny' | 'edit' | 'reply' | 'ignore' | 'snooze' | 'always'
interface Impact { what: string; tier: string; rewindable: boolean }
export interface UnifiedItem {
  id: string
  kind: Kind
  source: string
  approvalKind: string | null
  title: string
  body: string | null
  impact: Impact | null
  args: unknown
  count: number
  actions: ActionType[]
}
type Action = { type: ActionType; args?: unknown; text?: string; until?: number }

const ICON: Record<Kind, string> = { gate: 'shield', question: 'question', review: 'git-pull-request', notify: 'bell' }
const KIND_LABEL: Record<Kind, string> = { gate: 'Needs approval', question: 'Question', review: 'Review', notify: 'Update' }
/** Other ledger approvals have their own consent dialog below; only Claude prompts and inbox gates render here. */
const shownHere = (i: UnifiedItem): boolean => !(i.kind === 'gate' && i.source === 'approval' && i.approvalKind !== PERMISSION_KIND)

/** A PR review draft (src/server/prreview) is approved by posting it, so its button says what happens. */
export const approveLabel = (item: Pick<UnifiedItem, 'kind' | 'source'>): string =>
  item.source === 'prreview' ? 'Post review' : item.kind === 'review' ? 'Accept' : 'Approve once'

export function impactText(impact: Impact): string {
  return `${impact.what} · ${impact.tier} · ${impact.rewindable ? 'rewindable from a checkpoint' : 'cannot be rewound'}`
}

/** Snooze presets: an hour, or tomorrow 09:00 local time. */
export function snoozeUntil(choice: '1h' | 'tomorrow', now: number): number {
  if (choice === 'tomorrow') {
    const d = new Date(now)
    d.setDate(d.getDate() + 1)
    d.setHours(9, 0, 0, 0)
    return d.getTime()
  }
  return now + HOUR_MS
}

interface ItemsPage { items?: UnifiedItem[]; nextCursor?: string | null }

/** Reads the first `pages` pages of the server list; `more` = the server has items past them. */
async function fetchPages(pages: number, signal: AbortSignal): Promise<{ items: UnifiedItem[]; more: boolean; loaded: number }> {
  const items: UnifiedItem[] = []
  let cursor: string | null = null
  let loaded = 0
  // ponytail: every poll re-reads all loaded pages (≤ 200 items each); a delta feed if inboxes grow huge.
  do {
    const body: ItemsPage = await request<ItemsPage>(cursor === null ? INBOX_ITEMS_PATH : `${INBOX_ITEMS_PATH}?cursor=${encodeURIComponent(cursor)}`, { signal })
    items.push(...(body?.items ?? []))
    cursor = body?.nextCursor ?? null
    loaded++
  } while (cursor !== null && loaded < pages)
  return { items, more: cursor !== null, loaded }
}

const post = (path: string, body: unknown) =>
  request<Record<string, unknown>>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

export function InboxItems(props: { pollMs?: number; now?: () => number }): React.JSX.Element | null {
  const [items, setItems] = useState<UnifiedItem[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [tick, setTick] = useState(0)
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  const [draft, setDraft] = useState<{ id: string; mode: 'edit' | 'reply'; text: string } | null>(null)
  const [pages, setPages] = useState(1)
  const [loaded, setLoaded] = useState(0)
  const [more, setMore] = useState(false)
  const pollMs = props.pollMs ?? POLL_MS
  const now = props.now ?? Date.now

  useEffect(() => {
    const ctl = new AbortController()
    fetchPages(pages, ctl.signal)
      .then((res) => {
        const next = res.items.filter(shownHere)
        setItems(next)
        setMore(res.more)
        setLoaded(res.loaded)
        setSelected((prev) => new Set([...prev].filter((id) => next.some((i) => i.id === id))))
      })
      .catch((err: unknown) => { if (!isAbortError(err)) setError(inboxErrorMessage(err)) })
    const t = pollMs > 0 ? setTimeout(() => setTick((n) => n + 1), pollMs) : undefined
    return () => { ctl.abort(); if (t) clearTimeout(t) }
  }, [tick, pollMs, pages])

  const run = useCallback(async (call: () => Promise<Record<string, unknown>>) => {
    setBusy(true)
    setError(null)
    try {
      const res = await call()
      const refused = Array.isArray(res.results) ? (res.results as Array<{ status: number; body: { error?: string } }>).filter((r) => r.status !== 200) : []
      if (refused.length > 0) {
        const fatigue = refused.filter((r) => r.body.error === 'needs_individual_review').length
        setError(fatigue > 0 ? `${fatigue} item(s) cannot be rewound and must be approved one by one.` : `${refused.length} item(s) were not changed.`)
      }
      setDraft(null)
    } catch (err) {
      setError(inboxErrorMessage(err))
    } finally {
      setBusy(false)
      setTick((n) => n + 1) // the server list is the truth after any answer
    }
  }, [])

  const act = (id: string, action: Action) => void run(() => post(`${INBOX_ITEMS_PATH}/act`, { id, action }))
  const batch = (action: Action) => void run(() => post(`${INBOX_ITEMS_PATH}/batch`, { ids: [...selected], action }))
  const toggle = (id: string) => setSelected((prev) => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  /** A requested page is in flight; a page the server no longer has (list shrank) ends it via `more`. */
  const loadingMore = more && pages > loaded && error === null
  const retry = () => { setError(null); setTick((n) => n + 1) }

  if (items.length === 0 && !error) return null
  return (
    <section className="inbox-section" aria-label="Inbox items">
      {error && <InboxPanelError message={error} onRetry={retry} />}
      {selected.size > 0 && (
        <div className="inbox-bulk" role="toolbar" aria-label="Batch actions">
          <span>{selected.size} selected</span>
          <Button size="sm" disabled={busy} onClick={() => batch({ type: 'approve' })}>Approve selected</Button>
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => batch({ type: 'deny' })}>Deny selected</Button>
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => batch({ type: 'ignore' })}>Ignore selected</Button>
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => batch({ type: 'snooze', until: snoozeUntil('1h', now()) })}>Snooze selected 1h</Button>
        </div>
      )}
      <ul className="inbox-list">
        {items.map((item) => {
          const can = (a: ActionType) => item.actions.includes(a)
          const editing = draft?.id === item.id ? draft : null
          return (
            <li key={item.id} className="inbox-item" data-inbox-item={item.id} data-kind={item.kind} style={{ flexWrap: 'wrap' }}>
              <Checkbox className="inbox-check" aria-label={`Select ${item.title}`} checked={selected.has(item.id)} onCheckedChange={() => toggle(item.id)} />
              <span className={`codicon codicon-${ICON[item.kind]} inbox-state inbox-state--needs_you`} role="img" aria-label={KIND_LABEL[item.kind]} />
              <span className="inbox-item__title">{item.title}{item.count > 1 ? ` (×${item.count})` : ''}</span>
              {can('approve') && <Button size="sm" disabled={busy} onClick={() => act(item.id, { type: 'approve' })}>{approveLabel(item)}</Button>}
              {can('deny') && <Button size="sm" variant="secondary" disabled={busy} onClick={() => act(item.id, { type: 'deny' })}>Deny</Button>}
              {can('edit') && <Button size="sm" variant="secondary" disabled={busy} onClick={() => setDraft({ id: item.id, mode: 'edit', text: JSON.stringify(item.args ?? null, null, 2) })}>Edit</Button>}
              {can('reply') && <Button size="sm" variant="secondary" disabled={busy} onClick={() => setDraft({ id: item.id, mode: 'reply', text: '' })}>Reply</Button>}
              {can('always') && (
                <IconTooltip label="Saves a permanent rule (only from this window, never from Telegram)" disabled={busy} disabledReason="another action is running">
                  <Button size="sm" variant="secondary" disabled={busy} onClick={() => act(item.id, { type: 'always' })}>Always allow this pattern</Button>
                </IconTooltip>
              )}
              {can('snooze') && <Button size="sm" variant="ghost" disabled={busy} aria-label={`Snooze ${item.title} for 1 hour`} onClick={() => act(item.id, { type: 'snooze', until: snoozeUntil('1h', now()) })}>Snooze 1h</Button>}
              {can('snooze') && <Button size="sm" variant="ghost" disabled={busy} aria-label={`Snooze ${item.title} until tomorrow`} onClick={() => act(item.id, { type: 'snooze', until: snoozeUntil('tomorrow', now()) })}>Tomorrow</Button>}
              {can('ignore') && <Button size="sm" variant="ghost" disabled={busy} onClick={() => act(item.id, { type: 'ignore' })}>{item.kind === 'notify' ? 'Dismiss' : 'Ignore'}</Button>}
              {item.impact && <span className="inbox-item__desc" style={{ flexBasis: '100%' }}>{impactText(item.impact)}</span>}
              {item.body && <span className="inbox-item__desc" style={{ flexBasis: '100%', whiteSpace: 'pre-wrap' }}>{item.body}</span>}
              {editing && <Draft key={editing.mode} draft={editing} busy={busy} onText={(text) => setDraft({ ...editing, text })} onCancel={() => setDraft(null)}
                onSubmit={() => {
                  if (editing.mode === 'reply') return act(item.id, { type: 'reply', text: editing.text })
                  try { act(item.id, { type: 'edit', args: JSON.parse(editing.text) as unknown }) } catch { setError('The edited arguments are not valid JSON.') }
                }} />}
            </li>
          )
        })}
      </ul>
      {more && (
        <Button size="sm" variant="secondary" disabled={loadingMore} aria-busy={loadingMore} onClick={() => setPages(loaded + 1)}>
          {loadingMore ? 'Loading more…' : 'Load more'}
        </Button>
      )}
    </section>
  )
}

function Draft(props: { draft: { mode: 'edit' | 'reply'; text: string }; busy: boolean; onText(t: string): void; onSubmit(): void; onCancel(): void }) {
  const reply = props.draft.mode === 'reply'
  return (
    <span style={{ flexBasis: '100%', display: 'flex', gap: 4, alignItems: 'flex-start' }}>
      <Textarea aria-label={reply ? 'Reply to the agent' : 'Edit arguments'} rows={reply ? 2 : 4} style={{ flex: 1, fontFamily: reply ? undefined : 'monospace' }}
        value={props.draft.text} onChange={(e) => props.onText(e.target.value)} />
      <Button size="sm" disabled={props.busy || props.draft.text.trim() === ''} onClick={props.onSubmit}>{reply ? 'Send reply' : 'Approve with edits'}</Button>
      <Button size="sm" variant="ghost" disabled={props.busy} onClick={props.onCancel}>Cancel</Button>
    </span>
  )
}
