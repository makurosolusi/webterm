// Agent memory's data side: server paths, UI text, requests and the per-page incognito list. Split from
// AgentMemory.tsx so agent nodes (start-up) can read incognito state without loading the Settings section.
import { useEffect, useState } from 'react'

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
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const out: unknown = await res.json().catch(() => null)
  if (!res.ok) throw new Error((out as { error?: string } | null)?.error ?? `${method} ${path} -> ${res.status}`)
  return out
}

export const isFacts = (v: unknown): v is { facts: ProceduralFact[] } => !!v && Array.isArray((v as { facts?: unknown }).facts)
export const itemsOf = (v: unknown): MemoryItem[] | null => (v && Array.isArray((v as { items?: unknown }).items) ? (v as { items: MemoryItem[] }).items : null)
export const refsOf = (v: unknown): string[] => (v && Array.isArray((v as { refs?: unknown }).refs) ? (v as { refs: string[] }).refs : [])
export const NODE_PREFIX = 'node:'
export const ctl = (id: string, action: string): string => `${MEMORY_CONTROLS_PATH}/${encodeURIComponent(id)}/${action}`
export const INCOGNITO_PATH = `${MEMORY_CONTROLS_PATH}/incognito`

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
