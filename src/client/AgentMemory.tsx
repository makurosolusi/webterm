// "What agents remember": ONE list of everything remembered (`/api/memory2`), filtered by kind (All / Rules /
// Facts / Past sessions), with Confirm / Edit / Mute / Forget per item and the Remember field on top.
// Rules typed here are procedural memory (`/api/awareness/procedural`, loaded into every agent session);
// a rule an agent suggested is confirmed through that same route. Web-page suggestions can never be confirmed.
// Below: what was proposed while agents were idle, the shared notes (AgentMemoryBoard.tsx), and the
// incognito agents by node title. The server accepts these writes from this page only.
import { useCallback, useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { fetchWorkspaces } from './api'
import { ActionButton, ActionResult } from '@/components/ui/action'
import { BoardSection, MEMORY_BUSY, MemoryButton, ProposalsSection, useMemoryAction } from './AgentMemoryBoard'

import {
  ctl, INCOGNITO_PATH, isFacts, itemsOf, MEMORY_CONTROLS_PATH, MEMORY_TEXT, memoryRequest, NODE_PREFIX, PROCEDURAL_PATH, refsOf, setNodeIncognito,
  type MemoryItem, type MemoryKindFilter,
} from './AgentMemory.api'

// Existing importers (Settings, tests) keep using this path for the data side too.
export * from './AgentMemory.api'

type RowAct = (what: string, path: string, body?: unknown) => Promise<void>

function MemoryRow({ m, confirmable, act }: { m: MemoryItem; confirmable: boolean; act: RowAct }): React.JSX.Element {
  const [draft, setDraft] = useState<string | null>(null)
  // Forget cannot be undone (the server has no restore), so it asks first, like Central's own memory list.
  const [asking, setAsking] = useState(false)
  const untrusted = m.trust === 'external'
  // A claim is confirmed (procedural route); a fact that went stale is confirmed again (verify).
  const confirmPath = m.status === 'claim'
    ? (confirmable ? `${PROCEDURAL_PATH}/${encodeURIComponent(m.id)}/confirm` : null)
    : (m.needsReview ? ctl(m.id, 'verify') : null)
  // Forget and Save swap the buttons away on click, so their results live on the row.
  const forget = useMemoryAction(MEMORY_TEXT.forget, () => act(MEMORY_TEXT.forget, ctl(m.id, 'forget')))
  const save = useMemoryAction(MEMORY_TEXT.edit, async () => { await act(MEMORY_TEXT.edit, ctl(m.id, 'edit'), { text: (draft ?? '').trim() }); setDraft(null) })
  return (
    // Text on its own full-width line; badges and actions share one compact row under it (fits 300px and wide).
    <li data-memory={m.id} data-kind={m.kind} className="flex flex-col gap-1 border-b border-(--vscode-panel-border) py-1">
      {draft === null
        ? <span className="break-words [overflow-wrap:anywhere]">{m.text}</span>
        : <Input aria-label={MEMORY_TEXT.edit} value={draft} maxLength={1200} onChange={(e) => setDraft(e.target.value)} className="w-full min-w-0" />}
      <div data-slot="memory-row-meta" className="flex flex-wrap items-center gap-1">
        <Badge variant={m.status === 'fact' ? 'secondary' : 'outline'}>
          {untrusted ? MEMORY_TEXT.untrusted : m.status === 'fact' ? MEMORY_TEXT.confirmed : MEMORY_TEXT.suggested}
        </Badge>
        {m.needsReview ? <Badge variant="outline">{MEMORY_TEXT.review}</Badge> : null}
        {m.suppressed ? <Badge variant="outline">{MEMORY_TEXT.muted}</Badge> : null}
        <span data-slot="memory-row-actions" className="ml-auto flex flex-wrap items-center justify-end gap-1">
          {draft === null ? (
            <>
              {confirmPath ? <MemoryButton what={MEMORY_TEXT.confirm} busyLabel={MEMORY_BUSY.confirm} run={() => act(MEMORY_TEXT.confirm, confirmPath)} /> : null}
              {!untrusted ? <Button size="sm" variant="secondary" onClick={() => setDraft(m.text)}>{MEMORY_TEXT.edit}</Button> : null}
              <MemoryButton variant="secondary" what={m.suppressed ? MEMORY_TEXT.unmute : MEMORY_TEXT.mute} busyLabel={MEMORY_BUSY.mute}
                run={() => act(MEMORY_TEXT.mute, ctl(m.id, 'suppress'), { on: !m.suppressed })} />
              {asking ? (
                <span role="alertdialog" aria-label={MEMORY_TEXT.forgetAsk} className="flex flex-wrap items-center gap-1">
                  <span>{MEMORY_TEXT.forgetAsk}</span>
                  <ActionButton size="sm" variant="destructive" action={forget} busyLabel={MEMORY_BUSY.forget} onClick={() => setAsking(false)}>{MEMORY_TEXT.forget}</ActionButton>
                  <Button size="sm" variant="secondary" onClick={() => setAsking(false)}>{MEMORY_TEXT.cancel}</Button>
                </span>
              ) : <Button size="sm" variant="secondary" onClick={() => setAsking(true)}>{MEMORY_TEXT.forget}</Button>}
            </>
          ) : (
            <>
              <ActionButton size="sm" disabled={draft.trim() === ''} action={save} busyLabel={MEMORY_BUSY.save}>{MEMORY_TEXT.save}</ActionButton>
              <Button size="sm" variant="secondary" onClick={() => setDraft(null)}>{MEMORY_TEXT.cancel}</Button>
            </>
          )}
        </span>
      </div>
      <ActionResult action={forget} />
      <ActionResult action={save} />
    </li>
  )
}

/** Node id → title across every workspace; fetched only while some agent is incognito. */
function useNodeTitles(wanted: boolean): Map<string, string> | null {
  const [titles, setTitles] = useState<Map<string, string> | null>(null)
  useEffect(() => {
    if (!wanted) return
    fetchWorkspaces()
      .then((all) => setTitles(new Map(all.flatMap((ws) => ws.nodes.flatMap((n) => (n.title ? [[n.id, n.title] as const] : []))))))
      .catch((err: unknown) => { setTitles(new Map()); console.warn('incognito list: cannot load node titles:', err instanceof Error ? err.message : String(err)) })
  }, [wanted])
  return titles
}

/** Which part of the panel to show (Control › Memory filter): everything, only suggestions, or only shared notes. */
export type AgentMemoryPart = 'all' | 'suggested' | 'notes'

export function AgentMemory({ part = 'all' }: { part?: AgentMemoryPart } = {}): React.JSX.Element {
  const [items, setItems] = useState<MemoryItem[] | null>(null)
  const [confirmable, setConfirmable] = useState<ReadonlySet<string>>(new Set())
  const [loadError, setLoadError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [kind, setKind] = useState<MemoryKindFilter>('all')
  const [incognito, setIncognito] = useState<string[]>([])
  const [tick, setTick] = useState(0)
  const incognitoNodes = incognito.filter((r) => r.startsWith(NODE_PREFIX)).map((r) => r.slice(NODE_PREFIX.length))
  const titles = useNodeTitles(incognitoNodes.length > 0)

  const load = useCallback(() => {
    memoryRequest('GET', kind === 'all' ? MEMORY_CONTROLS_PATH : `${MEMORY_CONTROLS_PATH}?kind=${kind}`)
      .then((v) => { const list = itemsOf(v); setItems(list); setLoadError(list ? null : MEMORY_TEXT.loadFailed) })
      .catch((err: unknown) => setLoadError(err instanceof Error && err.message === 'ledger_off' ? MEMORY_TEXT.ledgerOff : MEMORY_TEXT.loadFailed))
    // Which agent-suggested rules may be confirmed (not from a web page); a failure only hides those Confirms.
    memoryRequest('GET', PROCEDURAL_PATH)
      .then((v) => setConfirmable(new Set(isFacts(v) ? v.facts.filter((f) => f.status === 'suggested' && !f.untrusted).map((f) => f.id) : [])))
      .catch(() => setConfirmable(new Set()))
    memoryRequest('GET', INCOGNITO_PATH).then((v) => setIncognito(refsOf(v))).catch(() => setIncognito([]))
    setTick((t) => t + 1)
  }, [kind])
  useEffect(load, [load])

  // Throws on failure: each button's action shows busy, then the result or the failure with Retry.
  const act = async (_what: string, method: string, path: string, body?: unknown): Promise<void> => {
    await memoryRequest(method, path, body)
    load()
  }
  const add = async (): Promise<void> => { await act(MEMORY_TEXT.add, 'POST', PROCEDURAL_PATH, { text: text.trim() }); setText('') }
  const leave = (nodeId: string): void => {
    setNodeIncognito(nodeId, false).then(setIncognito, (err: unknown) => setError(MEMORY_TEXT.failed(MEMORY_TEXT.leave, err instanceof Error ? err.message : String(err))))
  }
  const ready = items !== null

  return (
    <section aria-label={MEMORY_TEXT.title} data-testid="agent-memory">
      <h3 className="font-semibold">{MEMORY_TEXT.title}</h3>
      <p className="text-xs opacity-70">{MEMORY_TEXT.intro}</p>
      {loadError ? <p className="text-xs opacity-70">{loadError}</p> : null}
      {!ready && !loadError ? <p role="status" className="text-xs opacity-70">{MEMORY_TEXT.loading}</p> : null}
      {ready && part === 'all' ? (
        <div className="mt-2 flex flex-col gap-1 text-xs" data-testid="memory-all">
          <div className="flex items-center gap-2">
            <Input aria-label={MEMORY_TEXT.add} placeholder={MEMORY_TEXT.placeholder} value={text} maxLength={300}
              onChange={(e) => setText(e.target.value)} className="min-w-0 flex-1" />
            <MemoryButton what={MEMORY_TEXT.add} busyLabel={MEMORY_BUSY.add} run={add} disabled={text.trim() === ''} />
          </div>
          <div role="group" className="flex flex-wrap gap-1">
            {(Object.keys(MEMORY_TEXT.kinds) as MemoryKindFilter[]).map((k) => (
              <Button key={k} size="sm" variant={k === kind ? 'default' : 'secondary'} aria-pressed={k === kind} onClick={() => setKind(k)}>{MEMORY_TEXT.kinds[k]}</Button>
            ))}
          </div>
          {items.length === 0 ? <p className="opacity-70">{MEMORY_TEXT.empty}</p> : (
            <ul className="flex flex-col gap-1">
              {items.map((m) => <MemoryRow key={m.id} m={m} confirmable={confirmable.has(m.id)} act={(what, path, body) => act(what, 'POST', path, body)} />)}
            </ul>
          )}
        </div>
      ) : null}
      {ready && part !== 'notes' ? <ProposalsSection act={act} tick={tick} /> : null}
      {ready && part !== 'suggested' ? <BoardSection act={act} tick={tick} /> : null}
      {ready && part === 'all' ? (
        <div className="mt-3 flex flex-col gap-1 text-xs" data-testid="memory-incognito">
          <h4 className="font-semibold">{MEMORY_TEXT.incognitoTitle}</h4>
          <p className="opacity-70">{MEMORY_TEXT.incognitoIntro}</p>
          {incognitoNodes.length === 0 ? <p className="opacity-70">{MEMORY_TEXT.incognitoNone}</p> : (
            <ul className="flex flex-col gap-1">
              {incognitoNodes.map((id) => (
                <li key={id} data-incognito={id} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 break-words">{titles === null ? MEMORY_TEXT.loading : titles.get(id) ?? MEMORY_TEXT.incognitoGone}</span>
                  <Button size="sm" variant="secondary" onClick={() => leave(id)}>{MEMORY_TEXT.leave}</Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
    </section>
  )
}
