// Constructor dependencies of the browser host (split out of browserHost.service.ts).
import type { PersistedTabs } from '../../shared/browser.tabs'
import type { ShieldPolicy } from './adblock.shields'
import type { CdpClient } from './cdp.client'
import type { BrowserLauncher } from './chromium.launch'
import type { NavGuard } from './browserHost.targets'

export interface HostDeps {
  launcher: BrowserLauncher
  guard: NavGuard
  /** Default `CdpClient.connect`; test menyuntik server CDP tiruan. */
  connect?: (wsUrl: string) => Promise<CdpClient>
  /** Shields (blokir iklan/pelacak + sakelar per situs); tanpa ini hanya batas popup yang berlaku. */
  shields?: ShieldPolicy
  profileOf?: (nodeId: string, workspaceId: string) => string // profile of a node: its own `profileId` or the workspace's Default (browser.profile.ts)
  initialDevice?: (nodeId: string) => unknown // device saved on the board (`WsNode.device`): seeds a node seen first time
  now?: () => number
  initialTabs?: (nodeId: string) => unknown // tab list saved on the board (`WsNode.tabs`): seeds a node's tabs the first time its page opens
  persistTabs?: (nodeId: string, tabs: PersistedTabs | null) => void // write a node's tab list to the board (the host debounces)
  agentDriving?: (nodeId: string) => boolean // an agent holds the node's lease: popups its clicks open count as the agent's
  tabDiscardMs?: number // idle time before a background tab is discarded
}
