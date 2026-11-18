// Assembly of the browser downloads for the runtime: the file store under `<dataDir>/downloads`, the Settings mode and the hourly sweep
// of expired files. Kept out of browser.runtime.ts so that file stays an assembly line.
import { ENV_BROWSER } from '../../shared/browser.contract'
import type { Workspace } from '../../shared/workspace'
import { flagOr } from '../envFlag'
import { createDownloadStore } from './browser.downloads.store'
import type { HostDownloadsDeps, DownloadMode } from './browserHost.downloads'

/** How often expired downloads are removed (retention itself is `DOWNLOAD_RETENTION_MS`). */
const SWEEP_EVERY_MS = 3600_000

/** "Ask before keeping" only when the Settings switch is explicitly off; unset or junk is the default, save. */
export const downloadModeOf = (env: Record<string, string | undefined>): DownloadMode => (flagOr(env[ENV_BROWSER.downloadsAuto], true) ? 'save' : 'ask')

export interface DownloadWiring { deps: HostDownloadsDeps; stop(): void }

export function createDownloadWiring(d: {
  env: Record<string, string | undefined>
  dataRoot: string
  now: () => number
  workspaces(): Workspace[]
  profileOf(nodeId: string, workspaceId: string): string
}): DownloadWiring {
  const store = createDownloadStore({ root: d.dataRoot, now: d.now })
  const timer = setInterval(() => store.sweep(d.now()), SWEEP_EVERY_MS)
  timer.unref()
  return {
    deps: {
      store, mode: () => downloadModeOf(d.env),
      profileOfNode: (nodeId) => {
        const ws = d.workspaces().find((w) => w.nodes.some((n) => n.id === nodeId))
        return ws ? d.profileOf(nodeId, ws.id) : undefined
      },
    },
    stop: () => clearInterval(timer),
  }
}
