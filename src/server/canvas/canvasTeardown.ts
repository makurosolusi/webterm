// What a node removed by the server (CanvasPush.remove) still runs, ended the way a human close ends
// it: every pane's PTY session (the client sends `close` per pane leaf for every closed node, browser
// nodes included) and, for a browser node, its live page.
// Composed in index.ts over the process-wide sessions and browser runtime; importing those here would
// boot the PTY supervisor in every test that imports this file.
import type { BrowserRuntime } from '../browser/browser.state'
import { createLogger } from '../logs'
import type { CanvasNode } from './canvasPush'

const log = createLogger('canvas.teardown')

export interface CanvasTeardownDeps {
  sessions: { closeNodes(nodes: readonly CanvasNode[]): void }
  /** The running browser runtime, null when the browser feature is off. */
  browser(): Pick<BrowserRuntime, 'closeNode'> | null
}

export function createCanvasTeardown(deps: CanvasTeardownDeps): (nodes: CanvasNode[]) => void {
  return (nodes) => {
    deps.sessions.closeNodes(nodes)
    const browser = deps.browser()
    if (!browser) return
    for (const n of nodes) {
      if (n.kind !== 'browser') continue
      browser.closeNode(n.id).catch((err: unknown) => {
        log.warn('canvas.teardown.browser', 'Closing the page of a removed browser node failed', { ids: { nodeId: n.id }, cause: err instanceof Error ? err.name : typeof err })
      })
    }
  }
}
