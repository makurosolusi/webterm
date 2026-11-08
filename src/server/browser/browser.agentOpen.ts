// `open` for a canvas agent (nodeterm `open-browser --url`): a new browser node beside the caller on its own
// board, cabled to it, so every later verb reaches it through the same cable rules as one the human wired.
import { randomUUID } from 'node:crypto'
import { BROWSER_KIND } from '../../shared/browser.contract'
import type { BrowserState } from '../../shared/browser.contract'
import type { CanvasPush } from '../canvas/canvasPush'
import type { ControlResult } from '../control/controlTypes'

/** Same size as the client's URL-open path (`BROWSER_OPEN_SIZE`, client/browser.open.place.ts). */
const OPEN_SIZE = { width: 640, height: 400 }

export interface AgentOpenDeps {
  /** Async so the shared db is only loaded when an agent really opens a browser (same lazy pattern as `outbox`). */
  canvas(): Promise<Pick<CanvasPush, 'add' | 'workspaceOfNode'>>
  /** Start the page under the MAX_LIVE gate (`lifecycle.attach`); throws `BlockedError('max_live')` when full. */
  start(nodeId: string, workspaceId: string): Promise<BrowserState>
  newId?: () => string
}

/** `startError` = the node is on the board and cabled, only its page failed to start (kept, not removed). */
export type AgentOpened =
  | { ok: true; nodeId: string; url: string }
  | { ok: false; result: NonNullable<ControlResult> }
  | { ok: false; nodeId: string; startError: unknown }

const deny = (status: number, error: string, message: string): AgentOpened => ({ ok: false, result: { status, body: { error, message } } })

/** Add a browser node + cable beside `requesterId`, then start its page (blank; the caller navigates it). */
export async function openAgentBrowser(deps: AgentOpenDeps, requesterId: string, agentAllowed: (nodeId: string) => boolean): Promise<AgentOpened> {
  const canvas = await deps.canvas()
  const ws = canvas.workspaceOfNode(requesterId)
  if (!ws) return deny(404, 'not_on_board', 'This session is not a node on any webterm board.')
  const nodeId = (deps.newId ?? randomUUID)()
  if (!agentAllowed(nodeId)) return deny(403, 'disabled', 'Agent control of browser nodes is off in Settings. Only the user can turn it on; do not retry.')
  const added = canvas.add({
    workspaceId: ws.id, anchorNodeId: requesterId,
    nodes: [{ id: nodeId, kind: BROWSER_KIND, x: 0, y: 0, ...OPEN_SIZE }],
    bridges: [{ id: `bridge-${requesterId}-${nodeId}`, source: requesterId, target: nodeId, kind: 'context' }],
  })
  if (!added.ok) return deny(added.code === 'workspace_not_found' ? 404 : 409, added.code, 'Could not add a browser node to this board. Retry once, then tell the user.')
  try {
    const state = await deps.start(nodeId, ws.id)
    return { ok: true, nodeId, url: state.url }
  } catch (startError) {
    return { ok: false, nodeId, startError }
  }
}

/** Told to the agent with every `open` outcome that left a node on the board. */
export const openedNote = (nodeId: string, started: boolean): string => started
  ? `Browser node ${nodeId} is open beside you and cabled to you. Later verbs use it with no --node while it is your only cabled browser; otherwise pass --node ${nodeId}.`
  : `Browser node ${nodeId} was added beside you and cabled to you, but its page could not start. It starts when the user shows it on the canvas (if the live-browser limit is reached, another browser node must be closed or hidden first); then pass --node ${nodeId}.`
