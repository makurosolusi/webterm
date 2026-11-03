// Penampung runtime browser aktif (satu per proses), pola `ledgerRuntimeState`: modul yang menyambung
// (api.ts, control/mount.ts) hanya bertanya `activeBrowser()`; null (flag off) = tidak ada jalur sama sekali.
import type { WebSocket } from 'ws'
import type { BrowserStatusResp } from '../../shared/browser.contract'
import type { BrowserApiResult } from '../browserApi'
import type { ControlCapabilities, ControlRequest, ControlResult } from '../control/controlTypes'
import type { BrowserSessionHook } from '../sessionsTypes'

export interface BrowserRuntime {
  status(): BrowserStatusResp
  /** Layani satu socket `/ws/browser` milik workspace tertentu. */
  gateway(ws: WebSocket, workspaceId: string): void
  /** `/api/browser/*`; null = bukan prefix itu. */
  api(method: string, pathname: string, body: () => Promise<string>): Promise<BrowserApiResult | null>
  /** `/api/control/browser/*`; null = bukan prefix itu. */
  control(req: ControlRequest, capabilities: ControlCapabilities): Promise<ControlResult | null>
  sessionHook: BrowserSessionHook
  /** Matikan proxy, koneksi CDP, timer, dan proses Chromium. Idempoten. */
  shutdown(): Promise<void>
}

let active: BrowserRuntime | null = null

export const activeBrowser = (): BrowserRuntime | null => active
export const setActiveBrowser = (rt: BrowserRuntime | null): void => { active = rt }
