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
import { BoardSection, ProposalsSection } from './AgentMemoryBoard'

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
  return (
    <li data-memory={m.id} data-kind={m.kind} className="flex flex-wrap items-center gap-2">
      <Badge variant={m.status === 'fact' ? 'secondary' : 'outline'}>
        {untrusted ? MEMORY_TEXT.untrusted : m.status === 'fact' ? MEMORY_TEXT.confirmed : MEMORY_TEXT.suggested}
      </Badge>
      {m.needsReview ? <Badge variant="outline">{MEMORY_TEXT.review}</Badge> : null}
      {m.suppressed ? <Badge variant="outline">{MEMORY_TEXT.muted}</Badge> : null}
      {draft === null
        ? <span className="flex-1 break-words">{m.text}</span>
        : <Input aria-label={MEMORY_TEXT.edit} value={draft} maxLength={1200} onChange={(e) => setDraft(e.target.value)} className="min-w-48 flex-1" />}
      {draft === null ? (
        <>
          {confirmPath ? <Button size="sm" onClick={() => void act(MEMORY_TEXT.confirm, confirmPath)}>{MEMORY_TEXT.confirm}</Button> : null}
          {!untrusted ? <Button size="sm" variant="secondary" onClick={() => setDraft(m.text)}>{MEMORY_TEXT.edit}</Button> : null}
          <Button size="sm" variant="secondary" onClick={() => void act(MEMORY_TEXT.mute, ctl(m.id, 'suppress'), { on: !m.suppressed })}>
            {m.suppressed ? MEMORY_TEXT.unmute : MEMORY_TEXT.mute}
          </Button>
          {asking ? (
            <span role="alertdialog" aria-label={MEMORY_TEXT.forgetAsk} className="flex items-center gap-1">
              <span>{MEMORY_TEXT.forgetAsk}</span>
              <Button size="sm" variant="destructive" onClick={() => { setAsking(false); void act(MEMORY_TEXT.forget, ctl(m.id, 'forget')) }}>{MEMORY_TEXT.forget}</Button>
              <Button size="sm" variant="secondary" onClick={() => setAsking(false)}>{MEMORY_TEXT.cancel}</Button>
            </span>
          ) : <Button size="sm" variant="secondary" onClick={() => setAsking(true)}>{MEMORY_TEXT.forget}</Button>}
        </>
      ) : (
        <>
          <Button size="sm" disabled={draft.trim() === ''} onClick={() => { void act(MEMORY_TEXT.edit, ctl(m.id, 'edit'), { text: draft.trim() }); setDraft(null) }}>{MEMORY_TEXT.save}</Button>
          <Button size="sm" variant="secondary" onClick={() => setDraft(null)}>{MEMORY_TEXT.cancel}</Button>
        </>
      )}
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

  const act = async (what: string, method: string, path: string, body?: unknown): Promise<void> => {
    setError(null)
    try {
      await memoryRequest(method, path, body)
      load()
    } catch (err) { setError(MEMORY_TEXT.failed(what, err instanceof Error ? err.message : String(err))) }
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
              onChange={(e) => setText(e.target.value)} className="min-w-48 flex-1" />
            <Button size="sm" onClick={() => void add()} disabled={text.trim() === ''}>{MEMORY_TEXT.add}</Button>
          </div>
          <div role="group" className="flex gap-1">
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
                  <span className="flex-1">{titles === null ? MEMORY_TEXT.loading : titles.get(id) ?? MEMORY_TEXT.incognitoGone}</span>
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
