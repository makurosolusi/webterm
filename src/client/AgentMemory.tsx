// "What agents remember": ONE list of everything remembered (`/api/memory2`), filtered by kind (the Kind
// dropdown of Control › Memory, AgentMemoryFilters.tsx) and by a client-side search, with a count, a look-alike
// Merge suggestion (AgentMemoryMerge.tsx) and one row per item (AgentMemoryRow.tsx). "Waiting for your OK" sits on top.
// Adding is a "+ Add memory" button that opens the Remember field (Cursor's "+ Add Rule"): typing into the search box
// only filters, so one box never both searches and writes.
// Rules typed here are procedural memory (`/api/awareness/procedural`, loaded into every agent session);
// a rule an agent suggested is confirmed through that same route. Web-page suggestions can never be confirmed.
// Below the list: the shared notes (AgentMemoryBoard.tsx) and the
// incognito agents by node title. The server accepts these writes from this page only.
import { useCallback, useDeferredValue, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { fetchWorkspaces } from './api'
import { BoardSection, InfoHint, MEMORY_BUSY, MemoryButton, ProposalsSection, SectionTitle } from './AgentMemoryBoard'
import { MemoryRow } from './AgentMemoryRow'
import { MergeSuggestion } from './AgentMemoryMerge'

import {
  INCOGNITO_PATH, isFacts, itemsOf, MEMORY_CONTROLS_PATH, MEMORY_TEXT, memoryRequest, NODE_PREFIX, PROCEDURAL_PATH, refsOf, setNodeIncognito,
  type MemoryItem, type MemoryKindFilter,
} from './AgentMemory.api'

// Existing importers (Settings, tests) keep using this path for the data side too.
export * from './AgentMemory.api'

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

/** `kind` filters the remembered list; `filters` (the Source / Kind bar) sits under the Remember field, or on top when that is hidden. */
export function AgentMemory({ part = 'all', kind = 'all', filters }: { part?: AgentMemoryPart; kind?: MemoryKindFilter; filters?: React.ReactNode } = {}): React.JSX.Element {
  const [items, setItems] = useState<MemoryItem[] | null>(null)
  const [confirmable, setConfirmable] = useState<ReadonlySet<string>>(new Set())
  const [loadError, setLoadError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [adding, setAdding] = useState(false)
  const [query, setQuery] = useState('')
  // Typing stays responsive on long lists: the filter runs on the deferred value.
  const needle = useDeferredValue(query).trim().toLowerCase()
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
  const add = async (): Promise<void> => { await act(MEMORY_TEXT.add, 'POST', PROCEDURAL_PATH, { text: text.trim() }); setText(''); setAdding(false) }
  const leave = (nodeId: string): void => {
    setNodeIncognito(nodeId, false).then(setIncognito, (err: unknown) => setError(MEMORY_TEXT.failed(MEMORY_TEXT.leave, err instanceof Error ? err.message : String(err))))
  }
  const ready = items !== null
  const listShown = ready && part === 'all'
  const visible = items && needle ? items.filter((m) => m.text.toLowerCase().includes(needle)) : items

  return (
    <section aria-label={MEMORY_TEXT.title} data-testid="agent-memory">
      <div className="flex items-center gap-1">
        <h3 className="m-0 font-semibold">{MEMORY_TEXT.title}</h3>
        <InfoHint label={MEMORY_TEXT.about}><p>{MEMORY_TEXT.intro}</p></InfoHint>
      </div>
      {loadError ? <p className="m-0 text-xs opacity-70">{loadError}</p> : null}
      {!ready && !loadError ? <p role="status" className="m-0 text-xs opacity-70">{MEMORY_TEXT.loading}</p> : null}
      {!listShown && filters ? <div className="mt-2 text-xs">{filters}</div> : null}
      {ready && part !== 'notes' ? <ProposalsSection act={act} tick={tick} /> : null}
      {listShown && visible ? (
        <div className="mt-3 flex flex-col gap-1 text-xs" data-testid="memory-all">
          <div className="flex items-center gap-1">
            <Input type="search" aria-label={MEMORY_TEXT.search} placeholder={MEMORY_TEXT.searchPlaceholder} value={query}
              onChange={(e) => setQuery(e.target.value)} className="min-w-0 flex-1" />
            <Button size="sm" variant="secondary" aria-expanded={adding} onClick={() => setAdding(true)}>
              <span className="codicon codicon-add" aria-hidden="true" />{MEMORY_TEXT.addMemory}
            </Button>
          </div>
          {adding ? (
            // A form so Enter adds (implicit submit clicks the Remember button); Escape closes it.
            <form className="flex items-center gap-1" onSubmit={(e) => e.preventDefault()} onKeyDown={(e) => { if (e.key === 'Escape') setAdding(false) }}>
              <Input autoFocus aria-label={MEMORY_TEXT.add} placeholder={MEMORY_TEXT.placeholder} value={text} maxLength={300}
                onChange={(e) => setText(e.target.value)} className="min-w-0 flex-1" />
              <MemoryButton type="submit" what={MEMORY_TEXT.add} busyLabel={MEMORY_BUSY.add} run={add} disabled={text.trim() === ''} />
              <Button type="button" size="sm" variant="secondary" onClick={() => setAdding(false)}>{MEMORY_TEXT.cancel}</Button>
            </form>
          ) : null}
          <div className="flex flex-wrap items-center gap-1">
            {filters}
            <span className="ml-auto opacity-70" data-testid="memory-count" aria-live="polite">{MEMORY_TEXT.count(visible.length, items.length)}</span>
          </div>
          <MergeSuggestion items={items} act={act} />
          {items.length === 0 ? <p className="m-0 opacity-70">{MEMORY_TEXT.empty}</p>
            : visible.length === 0 ? <p className="m-0 opacity-70">{MEMORY_TEXT.noMatch}</p> : (
              <ul className="m-0 flex list-none flex-col gap-1 p-0">
                {visible.map((m) => <MemoryRow key={m.id} m={m} confirmable={confirmable.has(m.id)} act={(what, path, body) => act(what, 'POST', path, body)} />)}
              </ul>
            )}
        </div>
      ) : null}
      {ready && part !== 'suggested' ? <BoardSection act={act} tick={tick} /> : null}
      {ready && part === 'all' ? (
        <div className="mt-3 flex flex-col gap-1 text-xs" data-testid="memory-incognito">
          <SectionTitle title={MEMORY_TEXT.incognitoTitle} about={MEMORY_TEXT.incognitoAbout}><p>{MEMORY_TEXT.incognitoIntro}</p></SectionTitle>
          {incognitoNodes.length === 0 ? <p className="m-0 opacity-70">{MEMORY_TEXT.incognitoNone}</p> : (
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
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
