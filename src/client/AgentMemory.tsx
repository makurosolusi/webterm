// "What agents remember" section of Settings › Control: the user's procedural memory (standing rules and
// preferences loaded into every agent session). Suggestions made by agents or derived from web pages
// only take effect after a Confirm click here; the server accepts these writes from this page only.
import { useCallback, useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { TOKEN_HEADER } from './api'
import { peekToken } from './transportToken'

export const PROCEDURAL_PATH = '/api/awareness/procedural'

/** Mirror of the server `ProceduralFact` (src/server/awareness/proceduralMemory.ts). */
export interface ProceduralFact { id: string; text: string; status: 'verified' | 'suggested'; origin: string; updatedAt: number; useCount: number }

export const MEMORY_TEXT = {
  title: 'What agents remember',
  intro: 'Rules and preferences loaded into every agent session. Suggestions from agents or web pages are ignored until you confirm them.',
  loading: 'Loading…',
  loadFailed: 'Cannot load agent memory.',
  ledgerOff: 'Agent memory is unavailable while the ledger is off.',
  empty: 'Nothing remembered yet.',
  placeholder: 'e.g. Always run tests with TMPDIR=/tmp/st',
  add: 'Remember', confirm: 'Confirm', forget: 'Forget',
  verified: 'verified', suggested: 'suggested',
  from: (origin: string) => `from ${origin}`,
  failed: (what: string, why: string) => `${what} failed: ${why}`,
} as const

async function memoryRequest(method: string, path = PROCEDURAL_PATH, body?: unknown): Promise<unknown> {
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

export function AgentMemory(): React.JSX.Element {
  const [facts, setFacts] = useState<ProceduralFact[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [text, setText] = useState('')

  const load = useCallback(() => {
    memoryRequest('GET')
      .then((v) => { if (isFacts(v)) { setFacts(v.facts); setLoadError(null) } else setLoadError(MEMORY_TEXT.loadFailed) })
      .catch((err: unknown) => setLoadError(err instanceof Error && err.message === 'ledger_off' ? MEMORY_TEXT.ledgerOff : MEMORY_TEXT.loadFailed))
  }, [])
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
              {f.status === 'suggested'
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
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
    </section>
  )
}
