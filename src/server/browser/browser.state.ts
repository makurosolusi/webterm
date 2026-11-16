// Penampung runtime browser aktif (satu per proses), pola `ledgerRuntimeState`: modul yang menyambung
// (api.ts, control/mount.ts) hanya bertanya `activeBrowser()`; null (flag off) = tidak ada jalur sama sekali.
import type { WebSocket } from 'ws'
import type { BrowserState, BrowserStatusResp } from '../../shared/browser.contract'
import type { BrowserApiResult } from '../browserApi'
import type { ControlCapabilities, ControlRequest, ControlResult } from '../control/controlTypes'
import type { AgentOpened } from './browser.agentOpen'
import type { ProjectOpened } from './browser.projectOpen'

export interface BrowserRuntime {
  status(): BrowserStatusResp
  /** Live state of one browser node (central agent tools); undefined when the host does not know it. */
  state(nodeId: string): BrowserState | undefined
  /** Cookie domain names saved for a workspace (never values). */
  listDomains(workspaceId: string): Array<{ domain: string }>
  /** Layani satu socket `/ws/browser` milik workspace tertentu. */
  gateway(ws: WebSocket, workspaceId: string): void
  /** `/api/browser/*`; null = bukan prefix itu. */
  api(method: string, pathname: string, body: () => Promise<string>): Promise<BrowserApiResult | null>
  /** Server-side `open` for a canvas agent: browser node `nodeId` beside `requesterId`, cabled to it, page started (Central playbooks). */
  openFor?(requesterId: string, nodeId: string): Promise<AgentOpened>
  /** Adds a standalone browser node (no agent, no cable) to a workspace and starts its page; Central's `browser_read`. */
  openProject?(workspaceId: string, nodeId: string): Promise<ProjectOpened>
  /** `/api/control/browser/*`; null = bukan prefix itu. */
  control(req: ControlRequest, capabilities: ControlCapabilities): Promise<ControlResult | null>
  /** Hand a browser node's lease back to the human (idempotent); an agent's turn ended. */
  releaseLease(nodeId: string): void
  /** The node was removed from its board: close its page and drop its lease/lifecycle tracking. */
  closeNode(nodeId: string): Promise<void>
  /** Matikan proxy, koneksi CDP, timer, dan proses Chromium. Idempoten. */
  shutdown(): Promise<void>
}

let active: BrowserRuntime | null = null

export const activeBrowser = (): BrowserRuntime | null => active
export const setActiveBrowser = (rt: BrowserRuntime | null): void => { active = rt }
