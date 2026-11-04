// "What agents remember" section of Settings › Control: the user's procedural memory (standing rules and
// preferences loaded into every agent session). Suggestions made by agents or derived from web pages
// only take effect after a Confirm click here; the server accepts these writes from this page only.
// F5-a (ChatGPT memory controls): every remembered item by kind with Forget / Don't mention / Edit / Verify,
// freshness ("needs review"), and incognito agent nodes. Web-page suggestions can never be confirmed.
// F5-b: what the sleep-time consolidator proposed while agents were idle (Confirm all / per item / Dismiss),
// and the shared blackboard (goal status, decisions) with agent proposals waiting for a click.
import { useCallback, useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { TOKEN_HEADER } from './api'
import { peekToken } from './transportToken'
import { BoardSection, ProposalsSection } from './AgentMemoryBoard'

export const PROCEDURAL_PATH = '/api/awareness/procedural'
export const MEMORY_CONTROLS_PATH = '/api/memory2'

/** Mirror of the server `ProceduralFact` (src/server/awareness/proceduralMemory.ts). */
export interface ProceduralFact {
  id: string; text: string; status: 'verified' | 'suggested'; origin: string; updatedAt: number; useCount: number
  untrusted?: boolean; suppressed?: boolean
}

export type MemoryKindFilter = 'all' | 'semantic' | 'episodic' | 'procedural'
/** Mirror of the server `MemoryItemView` (src/server/memory/memoryControls.ts). */
export interface MemoryItem {
  id: string; kind: Exclude<MemoryKindFilter, 'all'>; scope: string; status: 'claim' | 'fact'; trust: string; origin: string | null
  title: string; text: string; suppressed: boolean; freshness: number; needsReview: boolean; validFrom: number | null; updatedAt: number
}

export const MEMORY_TEXT = {
  title: 'What agents remember',
  intro: 'Rules and preferences loaded into every agent session. Suggestions from agents or web pages are ignored until you confirm them.',
  loading: 'Loading…',
  loadFailed: 'Cannot load agent memory.',
  ledgerOff: 'Agent memory is unavailable while the ledger is off.',
  empty: 'Nothing remembered yet.',
  placeholder: 'e.g. Always run tests with TMPDIR=/tmp/st',
  add: 'Remember', confirm: 'Confirm', forget: 'Forget',
  verified: 'verified', suggested: 'suggested', untrusted: 'untrusted source, cannot be confirmed',
  from: (origin: string) => `from ${origin}`,
  failed: (what: string, why: string) => `${what} failed: ${why}`,
  allTitle: 'Everything remembered',
  kinds: { all: 'All', semantic: 'Facts', episodic: 'Episodes', procedural: 'Rules' } as Record<MemoryKindFilter, string>,
  mute: "Don't mention", unmute: 'Mention again', edit: 'Edit', save: 'Save', cancel: 'Cancel', verify: 'Verify',
  muted: 'muted', claim: 'unverified', review: 'needs review',
  incognitoTitle: 'Incognito agents',
  incognitoIntro: 'Nothing an incognito agent says or does is stored as memory.',
  incognitoNone: 'No agent is incognito.',
  incognito: 'Incognito', leave: 'Turn off',
  goIncognito: 'Go incognito (no memory)', leaveIncognito: 'Leave incognito',
} as const

export type MemoryAct = (what: string, method: string, path: string, body?: unknown) => Promise<void>

export async function memoryRequest(method: string, path = PROCEDURAL_PATH, body?: unknown): Promise<unknown> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  const t = peekToken()
  if (t !== '') headers[TOKEN_HEADER] = t
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const out: unknown = await res.json().catch(() => null)
  if (!res.ok) throw new Error((out as { error?: string } | null)?.error ?? `${method} ${path} -> ${res.status}`)
  return out
}

const isFacts = (v: unknown): v is { facts: ProceduralFact[] } => !!v && Array.isArray((v as { facts?: unknown }).facts)
const itemsOf = (v: unknown): MemoryItem[] | null => (v && Array.isArray((v as { items?: unknown }).items) ? (v as { items: MemoryItem[] }).items : null)
const refsOf = (v: unknown): string[] => (v && Array.isArray((v as { refs?: unknown }).refs) ? (v as { refs: string[] }).refs : [])
const NODE_PREFIX = 'node:'
export const ctl = (id: string, action: string): string => `${MEMORY_CONTROLS_PATH}/${encodeURIComponent(id)}/${action}`
const INCOGNITO_PATH = `${MEMORY_CONTROLS_PATH}/incognito`

// One incognito list per page, shared by the panel and every agent node's menu (one GET, not one per node).
let incognitoList: Promise<string[]> | null = null
const incognitoListeners = new Set<(refs: string[]) => void>()

/** Turns incognito on/off for an agent node and tells every mounted reader. Rejects with the server code. */
export async function setNodeIncognito(nodeId: string, on: boolean): Promise<string[]> {
  const refs = refsOf(await memoryRequest('PUT', INCOGNITO_PATH, { nodeId, on }))
  incognitoList = Promise.resolve(refs)
  for (const l of incognitoListeners) l(refs)
  return refs
}

/** Whether `nodeId` is incognito, kept in sync with every toggle on the page. */
export function useNodeIncognito(nodeId: string): boolean {
  const [refs, setRefs] = useState<string[]>([])
  useEffect(() => {
    incognitoListeners.add(setRefs)
    // Ledger off or offline: shown as not incognito; the next mount asks again.
    incognitoList ??= memoryRequest('GET', INCOGNITO_PATH).then(refsOf).catch(() => { incognitoList = null; return [] })
    void incognitoList.then(setRefs)
    return () => { incognitoListeners.delete(setRefs) }
  }, [])
  return refs.includes(`${NODE_PREFIX}${nodeId}`)
}

/** Incognito switch for one agent node; node chrome can mount it next to the agent title. */
export function IncognitoToggle({ nodeId, on, onChange }: { nodeId: string; on: boolean; onChange?: (refs: string[]) => void }): React.JSX.Element {
  return (
    <label className="flex items-center gap-1 text-xs">
      <Switch aria-label={`${MEMORY_TEXT.incognito} ${nodeId}`} checked={on}
        onCheckedChange={(v) => { setNodeIncognito(nodeId, v === true).then((r) => onChange?.(r), (err: unknown) => console.error(`incognito switch for node ${nodeId}:`, err)) }} />
      {MEMORY_TEXT.incognito}
    </label>
  )
}


function MemoryRow({ m, act }: { m: MemoryItem; act: (what: string, path: string, body?: unknown) => Promise<void> }): React.JSX.Element {
  const [draft, setDraft] = useState<string | null>(null)
  return (
    <li data-memory={m.id} data-kind={m.kind} className="flex flex-wrap items-center gap-2">
      {m.status === 'claim' ? <Badge variant="outline">{MEMORY_TEXT.claim}</Badge> : null}
      {m.needsReview ? <Badge variant="outline">{MEMORY_TEXT.review}</Badge> : null}
      {m.suppressed ? <Badge variant="outline">{MEMORY_TEXT.muted}</Badge> : null}
      {draft === null
        ? <span className="flex-1 break-words">{m.text}</span>
        : <Input aria-label={MEMORY_TEXT.edit} value={draft} maxLength={1200} onChange={(e) => setDraft(e.target.value)} className="min-w-48 flex-1" />}
      {draft === null ? (
        <>
          {m.status === 'fact' ? <Button size="sm" variant="secondary" onClick={() => void act(MEMORY_TEXT.verify, ctl(m.id, 'verify'))}>{MEMORY_TEXT.verify}</Button> : null}
          {m.trust !== 'external' ? <Button size="sm" variant="secondary" onClick={() => setDraft(m.text)}>{MEMORY_TEXT.edit}</Button> : null}
          <Button size="sm" variant="secondary" onClick={() => void act(MEMORY_TEXT.mute, ctl(m.id, 'suppress'), { on: !m.suppressed })}>
            {m.suppressed ? MEMORY_TEXT.unmute : MEMORY_TEXT.mute}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => void act(MEMORY_TEXT.forget, ctl(m.id, 'forget'))}>{MEMORY_TEXT.forget}</Button>
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

export function AgentMemory(): React.JSX.Element {
  const [facts, setFacts] = useState<ProceduralFact[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [kind, setKind] = useState<MemoryKindFilter>('all')
  const [items, setItems] = useState<MemoryItem[] | null>(null)
  const [incognito, setIncognito] = useState<string[]>([])
  const [tick, setTick] = useState(0)

  const load = useCallback(() => {
    memoryRequest('GET')
      .then((v) => { if (isFacts(v)) { setFacts(v.facts); setLoadError(null) } else setLoadError(MEMORY_TEXT.loadFailed) })
      .catch((err: unknown) => setLoadError(err instanceof Error && err.message === 'ledger_off' ? MEMORY_TEXT.ledgerOff : MEMORY_TEXT.loadFailed))
    // The controls list is an extra; a failure here leaves the rules section working.
    memoryRequest('GET', kind === 'all' ? MEMORY_CONTROLS_PATH : `${MEMORY_CONTROLS_PATH}?kind=${kind}`)
      .then((v) => setItems(itemsOf(v))).catch(() => setItems(null))
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
  const item = (id: string, suffix = ''): string => `${PROCEDURAL_PATH}/${encodeURIComponent(id)}${suffix}`

  return (
    <section aria-label={MEMORY_TEXT.title} data-testid="agent-memory">
      <h3 className="font-semibold">{MEMORY_TEXT.title}</h3>
      <p className="text-xs opacity-70">{MEMORY_TEXT.intro}</p>
      {loadError ? <p className="text-xs opacity-70">{loadError}</p> : null}
      {facts === null && !loadError ? <p role="status" className="text-xs opacity-70">{MEMORY_TEXT.loading}</p> : null}
      {facts?.length === 0 ? <p className="text-xs opacity-70">{MEMORY_TEXT.empty}</p> : null}
      {facts && facts.length > 0 ? (
        <ul className="flex flex-col gap-1 text-xs">
          {facts.map((f) => (
            <li key={f.id} data-fact={f.id} data-status={f.status} className="flex items-center gap-2">
              <Badge variant={f.status === 'verified' ? 'secondary' : 'outline'} className="min-w-16 justify-center">{MEMORY_TEXT[f.status]}</Badge>
              <span className="flex-1 break-words">{f.text}
                {f.status === 'suggested' ? <span className="opacity-70"> · {MEMORY_TEXT.from(f.origin)}</span> : null}
              </span>
              {f.untrusted ? <Badge variant="outline">{MEMORY_TEXT.untrusted}</Badge> : null}
              {f.status === 'suggested' && !f.untrusted
                ? <Button size="sm" onClick={() => void act(MEMORY_TEXT.confirm, 'POST', item(f.id, '/confirm'))}>{MEMORY_TEXT.confirm}</Button>
                : null}
              <Button size="sm" variant="secondary" onClick={() => void act(MEMORY_TEXT.forget, 'DELETE', item(f.id))}>{MEMORY_TEXT.forget}</Button>
            </li>
          ))}
        </ul>
      ) : null}
      {facts ? (
        <div className="mt-2 flex items-center gap-2 text-xs">
          <Input aria-label={MEMORY_TEXT.add} placeholder={MEMORY_TEXT.placeholder} value={text} maxLength={300}
            onChange={(e) => setText(e.target.value)} className="min-w-48 flex-1" />
          <Button size="sm" onClick={() => void add()} disabled={text.trim() === ''}>{MEMORY_TEXT.add}</Button>
        </div>
      ) : null}
      {items ? (
        <div className="mt-3 flex flex-col gap-1 text-xs" data-testid="memory-all">
          <h4 className="font-semibold">{MEMORY_TEXT.allTitle}</h4>
          <div role="group" className="flex gap-1">
            {(Object.keys(MEMORY_TEXT.kinds) as MemoryKindFilter[]).map((k) => (
              <Button key={k} size="sm" variant={k === kind ? 'default' : 'secondary'} aria-pressed={k === kind} onClick={() => setKind(k)}>{MEMORY_TEXT.kinds[k]}</Button>
            ))}
          </div>
          {items.length === 0 ? <p className="opacity-70">{MEMORY_TEXT.empty}</p> : (
            <ul className="flex flex-col gap-1">
              {items.map((m) => <MemoryRow key={m.id} m={m} act={(what, path, body) => act(what, 'POST', path, body)} />)}
            </ul>
          )}
        </div>
      ) : null}
      {facts ? <ProposalsSection act={act} tick={tick} /> : null}
      {facts ? <BoardSection act={act} tick={tick} /> : null}
      {facts ? (
        <div className="mt-3 flex flex-col gap-1 text-xs" data-testid="memory-incognito">
          <h4 className="font-semibold">{MEMORY_TEXT.incognitoTitle}</h4>
          <p className="opacity-70">{MEMORY_TEXT.incognitoIntro}</p>
          {incognito.length === 0 ? <p className="opacity-70">{MEMORY_TEXT.incognitoNone}</p> : (
            <ul className="flex flex-col gap-1">
              {incognito.filter((r) => r.startsWith(NODE_PREFIX)).map((r) => (
                <li key={r} className="flex items-center gap-2"><span className="flex-1">{r.slice(NODE_PREFIX.length)}</span>
                  <IncognitoToggle nodeId={r.slice(NODE_PREFIX.length)} on onChange={setIncognito} /></li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
    </section>
  )
}
