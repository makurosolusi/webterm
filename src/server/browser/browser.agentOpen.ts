// `open` for a canvas agent: a new browser node beside the caller on its own
// board, cabled to it, so every later verb reaches it through the same cable rules as one the human wired.
import { randomUUID } from 'node:crypto'
import { BROWSER_KIND } from '../../shared/browser.contract'
import type { BrowserState } from '../../shared/browser.contract'
import type { CanvasPush } from '../canvas/canvasPush'
import type { ControlResult } from '../control/controlTypes'
import { cableGrants } from '../policy/policy.cable'
import { resolveProfileId } from '../../shared/browser.profile'
import type { BrowserProfile } from '../../shared/browser.profile'

/** Same size as the client's URL-open path (`BROWSER_OPEN_SIZE`, client/browser.open.place.ts). */
export const OPEN_SIZE ={ width: 640, height: 400 }

export interface AgentOpenDeps {
  /** Async so the shared db is only loaded when an agent really opens a browser (same lazy pattern as `outbox`). */
  canvas(): Promise<Pick<CanvasPush, 'add' | 'workspaceOfNode'>>
  /** Start the page under the MAX_LIVE gate (`lifecycle.attach`); throws `BlockedError('max_live')` when full. */
  start(nodeId: string, workspaceId: string): Promise<BrowserState>
  newId?: () => string
  /** Profile registry for `open --profile`; absent = profiles unavailable (a requested profile is refused, none = Default). */
  profiles?: { resolve(ref: string, workspaceId: string): BrowserProfile | undefined; list(workspaceId: string): BrowserProfile[] }
  /** Profile a board node runs in (live switch included); default = the stored `profileId` or the workspace's Default. */
  profileOfNode?(nodeId: string, workspaceId: string): string
}

/** `startError` = the node is on the board and cabled, only its page failed to start (kept, not removed). */
export type AgentOpened =
  | { ok: true; nodeId: string; url: string; reused?: boolean; profile?: string }
  | { ok: false; result: NonNullable<ControlResult> }
  | { ok: false; nodeId: string; startError: unknown }

const deny = (status: number, error: string, message: string): AgentOpened => ({ ok: false, result: { status, body: { error, message } } })

/** Which cabled browser an open takes instead of adding one: Central's (`openFor`) takes any, the agent's own only the one Central opened for it. */
export type OpenReuse = 'cabled' | 'assigned'

// Opens per caller run one after another, so Central's pre-assigned open (playbook.web_research) and the agent's own first
// `open`/`navigate` can never both add a node: whichever runs second finds the first one cabled and reuses it.
const opening = new Map<string, Promise<unknown>>()
// ponytail: in memory; after a restart the agent's own `open` adds a new node again (Central no longer has one pending).
const assigned = new Map<string, string>()

/**
 * Add a browser node + cable beside `requesterId`, then start its page (blank; the caller navigates it). A browser already
 * cabled to it (per `reuse`) is returned instead (`reused`), so a caller never ends up with a duplicate.
 */
export function openAgentBrowser(deps: AgentOpenDeps, requesterId: string, agentAllowed: (nodeId: string) => boolean, reuse: OpenReuse = 'assigned', profile?: string): Promise<AgentOpened> {
  const run = (opening.get(requesterId) ?? Promise.resolve()).then(() => openOnce(deps, requesterId, agentAllowed, reuse, profile))
  opening.set(requesterId, run)
  const clear = (): void => { if (opening.get(requesterId) === run) opening.delete(requesterId) }
  run.then(clear, clear)
  return run
}

async function openOnce(deps: AgentOpenDeps, requesterId: string, agentAllowed: (nodeId: string) => boolean, reuse: OpenReuse, profile?: string): Promise<AgentOpened> {
  const canvas = await deps.canvas()
  const ws = canvas.workspaceOfNode(requesterId)
  if (!ws) return deny(404, 'not_on_board', 'This session is not a node on any webterm board.')
  const wanted = profile === undefined ? undefined : deps.profiles?.resolve(profile, ws.id)
  // A profile bound to another board is not this agent's to use; a name that matches nothing lists what exists (no guessing).
  if (profile !== undefined && (!wanted || (wanted.workspaceId !== null && wanted.workspaceId !== ws.id))) {
    const names = (deps.profiles?.list(ws.id) ?? []).map((p) => `"${p.name}"`).join(', ')
    return deny(404, 'profile_not_found', `No browser profile "${profile}". Available: ${names || 'none'}. Pass one of these names or ids as --profile, or omit it for this board's default.`)
  }
  const profileOfNode = (id: string): string => deps.profileOfNode?.(id, ws.id) ?? resolveProfileId(ws.id, ws.nodes.find((n) => n.id === id))
  // Reuse only a browser on the SAME profile: never hand an agent the wrong account. No `profile` asked = the old behavior.
  const cabled = cableGrants([ws], requesterId).map((g) => g.scope.slice('node:'.length)).filter((id) => !wanted || profileOfNode(id) === wanted.id)
  const mine = assigned.get(requesterId)
  const existing = reuse === 'cabled' ? cabled[0] : mine !== undefined && cabled.includes(mine) ? mine : undefined
  if (existing !== undefined) {
    if (reuse === 'cabled') assigned.set(requesterId, existing)
    return { ok: true, nodeId: existing, url: '', reused: true, ...(wanted ? { profile: wanted.name } : {}) }
  }
  const nodeId = (deps.newId ?? randomUUID)()
  if (!agentAllowed(nodeId)) return deny(403, 'disabled', 'Agent control of browser nodes is off in Settings. Only the user can turn it on; do not retry.')
  const added = canvas.add({
    workspaceId: ws.id, anchorNodeId: requesterId,
    nodes: [{ id: nodeId, kind: BROWSER_KIND, x: 0, y: 0, ...OPEN_SIZE, ...(wanted && wanted.id !== ws.id ? { profileId: wanted.id } : {}) }],
    bridges: [{ id: `bridge-${requesterId}-${nodeId}`, source: requesterId, target: nodeId, kind: 'context' }],
  })
  if (!added.ok) return deny(added.code === 'workspace_not_found' ? 404 : 409, added.code, 'Could not add a browser node to this board. Retry once, then tell the user.')
  if (reuse === 'cabled') assigned.set(requesterId, nodeId)
  try {
    const state = await deps.start(nodeId, ws.id)
    return { ok: true, nodeId, url: state.url, ...(wanted ? { profile: wanted.name } : {}) }
  } catch (startError) {
    return { ok: false, nodeId, startError }
  }
}

/** Told to the agent with every `open` outcome that left a node on the board. */
export const openedNote = (nodeId: string, started: boolean, profile?: string): string => started
  ? `Browser node ${nodeId} is open beside you and cabled to you${profile ? ` on profile "${profile}" (its own logins)` : ''}. Later verbs use it with no --node while it is your only cabled browser; otherwise pass --node ${nodeId}.`
  : `Browser node ${nodeId} was added beside you and cabled to you, but its page could not start. It starts when the user shows it on the canvas (if the live-browser limit is reached, another browser node must be closed or hidden first); then pass --node ${nodeId}.`
