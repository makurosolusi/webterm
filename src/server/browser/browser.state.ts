// Penampung runtime browser aktif (satu per proses), pola `ledgerRuntimeState`: modul yang menyambung
// (api.ts, control/mount.ts) hanya bertanya `activeBrowser()`; null (flag off) = tidak ada jalur sama sekali.
import type { WebSocket } from 'ws'
import type { BrowserState, BrowserStatusResp } from '../../shared/browser.contract'
import type { BrowserApiResult } from '../browserApi'
import type { ControlCapabilities, ControlRequest, ControlResult } from '../control/controlTypes'

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
  /** `/api/control/browser/*`; null = bukan prefix itu. */
  control(req: ControlRequest, capabilities: ControlCapabilities): Promise<ControlResult | null>
  /** Hand a browser node's lease back to the human (idempotent); an agent's turn ended. */
  releaseLease(nodeId: string): void
  /** Matikan proxy, koneksi CDP, timer, dan proses Chromium. Idempoten. */
  shutdown(): Promise<void>
}

let active: BrowserRuntime | null = null

export const activeBrowser = (): BrowserRuntime | null => active
export const setActiveBrowser = (rt: BrowserRuntime | null): void => { active = rt }
