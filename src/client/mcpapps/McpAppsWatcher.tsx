// Places App nodes: when an agent publishes an MCP Apps view (`mcpapp.published` on the events SSE
// stream, /api/events/stream?kind=…), claims the apps of this canvas and adds each one, once, to the right
// of the agent that opened it. Claims on mount and on every (re)connect too, so a view published while
// no tab was open still lands. A dropped stream reopens via `scheduleStreamRetry` (jittered, waits for
// the shared socket while the server is down); a refused one (ledger off -> 503) falls back to a slow
// poll that skips its ticks while the shared socket is down. Must render inside <ReactFlow> (uses its store); nodes enter through `addNodes`, which the board
// saves as an 'add' change (App.board onNodesChange).
import { useEffect } from 'react'
import { useReactFlow, type Node } from '@xyflow/react'
import { claimApps } from './mcpApp.api'
import { afterPageLoad } from '../pageLoad'
import { scheduleStreamRetry, streamPaused } from '../ws.connection'

export const APP_NODE_KIND = 'app'
/** Must match APP_PUBLISHED_EVENT in src/server/mcpapps/mcpApp.publish.ts. */
export const APP_PUBLISHED_EVENT = 'mcpapp.published'
export const APP_STREAM_URL = `/api/events/stream?kind=${APP_PUBLISHED_EVENT}`
/** Only while the stream is down for good. */
export const APP_FALLBACK_POLL_MS = 30_000
export const APP_NODE_SIZE = { width: 480, height: 360 }
const GAP = 40

/** The App node for `app`, placed beside its owner (or at the origin when the owner is not drawn). */
export function appNodeFor(app: { id: string; ownerNodeId: string }, owner: Node | undefined): Node {
  const x = owner ? owner.position.x + (owner.width ?? owner.measured?.width ?? 0) + GAP : 0
  const y = owner ? owner.position.y : 0
  return { id: app.id, type: APP_NODE_KIND, position: { x, y }, ...APP_NODE_SIZE, data: { id: app.id, kind: APP_NODE_KIND } }
}

export default function McpAppsWatcher() {
  const rf = useReactFlow()
  useEffect(() => {
    let busy = false
    let again = false
    const claim = async (): Promise<void> => {
      if (busy) { again = true; return }
      busy = true
      try {
        const ids = rf.getNodes().filter((n) => n.type !== APP_NODE_KIND).map((n) => n.id)
        if (!ids.length) return
        const { apps } = await claimApps(ids)
        const fresh = apps.filter((a) => !rf.getNode(a.id))
        if (fresh.length) rf.addNodes(fresh.map((a) => appNodeFor(a, rf.getNode(a.ownerNodeId))))
      } catch {
        // Claim request failed (server restarting/offline): nothing was claimed; the next event, reconnect or poll asks again.
      } finally {
        busy = false
        if (again) { again = false; void claim() }
      }
    }
    let poll: ReturnType<typeof setInterval> | null = null
    let source: EventSource | null = null
    let attempts = 0
    let cancelRetry = (): void => {}
    // A tick while the server is unreachable would only fail; the reconnect's onopen claims anyway.
    const startPoll = (): void => {
      poll ??= setInterval(() => { if (!streamPaused()) void claim() }, APP_FALLBACK_POLL_MS)
    }
    const open = (): void => {
      const next = new EventSource(APP_STREAM_URL)
      source = next
      next.onopen = () => { attempts = 0; void claim() }
      next.addEventListener('sense', () => void claim())
      // CLOSED = refused (non-200): poll slowly. Otherwise the browser would retry on its own fixed
      // interval, unjittered and blind to the socket; close it and reopen on the shared schedule.
      next.onerror = () => {
        const refused = next.readyState === EventSource.CLOSED
        next.close()
        source = null
        if (refused) { startPoll(); return }
        cancelRetry()
        cancelRetry = scheduleStreamRetry(attempts++, open)
      }
    }
    let cancelStart = (): void => {}
    if (typeof EventSource !== 'undefined') cancelStart = afterPageLoad(open)
    else startPoll()
    void claim()
    return () => { cancelStart(); cancelRetry(); source?.close(); if (poll) clearInterval(poll) }
  }, [rf])
  return null
}
