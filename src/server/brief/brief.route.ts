// HTTP for the morning brief. Root token / same-origin UI only (not in `isNodeTokenPath`):
//   GET  /api/brief          -> BriefResponse (cached; counts as user activity)
//   POST /api/brief/dismiss  -> BriefResponse with dismissed: true (persisted per visit)
import { join } from 'node:path'
import type { RouteResult } from '../apiShared.types'
import type { Workspace } from '../../shared/workspace'
import { createBriefService, type BriefService } from './brief.service'
import { headSeq, readBriefSource } from './brief.source'
import { renderBriefText } from './brief.model'

export const BRIEF_PATH = '/api/brief'
export const BRIEF_DISMISS_PATH = `${BRIEF_PATH}/dismiss`
export const BRIEF_STATE_FILE = 'brief-state.json'
const LABEL_TTL_MS = 5_000
const PRESENCE_SAMPLE_MS = 60_000

/** Node + workspace display names from the workspace store, memoised briefly per build. */
export function workspaceLabels(list: () => Workspace[], now: () => number = Date.now) {
  let at = -Infinity
  let nodes = new Map<string, string>()
  let spaces = new Map<string, string>()
  const fresh = (): void => {
    if (now() - at < LABEL_TTL_MS) return
    at = now()
    nodes = new Map()
    spaces = new Map()
    for (const ws of list()) {
      spaces.set(ws.id, ws.name)
      for (const n of ws.nodes) {
        const base = n.title?.trim() || (n.agentId ? n.agentId[0]!.toUpperCase() + n.agentId.slice(1) : n.kind === 'terminal' ? 'Terminal' : n.kind)
        nodes.set(n.id, `${base} in ${ws.name}`)
      }
    }
  }
  return {
    nodeLabel(id: string): string {
      fresh()
      return nodes.get(id) ?? nodes.get(id.split(':')[0] ?? id) ?? `Node ${id.slice(0, 8)}`
    },
    workspaceLabel(id: string): string {
      fresh()
      return spaces.get(id) ?? `workspace ${id.slice(0, 8)}`
    },
  }
}

let active: BriefService | null = null

/** The process brief service, created on first use (bun:sqlite and the data dir load lazily). */
async function productionService(): Promise<BriefService> {
  if (active) return active
  const [{ db }, { dataDir }, { activeLedgerRuntime }, { presence }, { eventBus }] = await Promise.all([
    import('../db'), import('../config'), import('../ledger/ledgerRuntimeState'), import('../channels/channelPresence'), import('../events/eventBus'),
  ])
  const labels = workspaceLabels(() => db.list())
  // The tracker starts "seen" at boot; only a later ping is real presence.
  const bootVisible = Date.now() - presence.awayMs()
  active ??= createBriefService({
    statePath: join(dataDir(), BRIEF_STATE_FILE),
    read: (since, now) => { const l = activeLedgerRuntime(); return l ? readBriefSource(l.db, since, now) : null },
    headSeq: () => { const l = activeLedgerRuntime(); return l ? headSeq(l.db) : 0 },
    ...labels,
    lastVisibleAt: () => { const v = Date.now() - presence.awayMs(); return v > bootVisible + 1000 ? v : null },
    subscribe: (pattern, fn) => eventBus.subscribe(pattern, fn),
    sampleEveryMs: PRESENCE_SAMPLE_MS,
  })
  return active
}

/** Telegram worker entry: the current brief as plain text (see `renderBriefText`). */
export async function morningBriefText(): Promise<string> {
  return renderBriefText((await productionService()).peek())
}

/** null = not a brief path. */
export async function briefRoute(path: string, method: string, service?: BriefService): Promise<RouteResult | null> {
  if (path !== BRIEF_PATH && path !== BRIEF_DISMISS_PATH) return null
  const want = path === BRIEF_PATH ? 'GET' : 'POST'
  if (method !== want) return { status: 405, body: { error: 'method_not_allowed' } }
  const svc = service ?? (await productionService())
  return { status: 200, body: path === BRIEF_PATH ? svc.get() : svc.dismiss() }
}
