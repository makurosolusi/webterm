// A standalone browser node on a project's board (no agent, no cable): what Central opens to read one page itself.
// Same gates as `openAgentBrowser`: agent-control switch, MAX_LIVE (page start through `lifecycle.attach`), board writer.
import { randomUUID } from 'node:crypto'
import { BROWSER_KIND, BlockedError } from '../../shared/browser.contract'
import type { BrowserState } from '../../shared/browser.contract'
import type { CanvasPush } from '../canvas/canvasPush'
import { OPEN_SIZE } from './browser.agentOpen'

export interface ProjectOpenDeps {
  /** `remove` is optional: without it a node whose page could not start stays on the board. */
  canvas(): Promise<Pick<CanvasPush, 'add'> & Partial<Pick<CanvasPush, 'remove'>>>
  /** Starts the page under the MAX_LIVE gate; throws `BlockedError('max_live')` when full. */
  start(nodeId: string, workspaceId: string): Promise<BrowserState>
  newId?: () => string
}

/** `browser_limit` = every live slot is taken; the other codes are the board writer's or the page start's own. */
export type ProjectOpened = { ok: true; nodeId: string } | { ok: false; code: string }

/** Adds a browser node to `workspaceId` and starts its blank page; a node that cannot start is taken off the board again. */
export async function openProjectBrowser(deps: ProjectOpenDeps, workspaceId: string, agentAllowed: (nodeId: string) => boolean, wantedId?: string): Promise<ProjectOpened> {
  const nodeId = wantedId ?? (deps.newId ?? randomUUID)()
  if (!agentAllowed(nodeId)) return { ok: false, code: 'disabled' }
  const canvas = await deps.canvas()
  const added = canvas.add({ workspaceId, nodes: [{ id: nodeId, kind: BROWSER_KIND, x: 0, y: 0, ...OPEN_SIZE }] })
  if (!added.ok) return { ok: false, code: added.code }
  try {
    await deps.start(nodeId, workspaceId)
    return { ok: true, nodeId }
  } catch (err) {
    canvas.remove?.({ workspaceId, nodeIds: [nodeId] })
    return { ok: false, code: err instanceof BlockedError && err.reason === 'max_live' ? 'browser_limit' : 'launch_failed' }
  }
}
