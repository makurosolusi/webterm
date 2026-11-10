// Chat <-> terminal view switch of one Claude node (`POST /api/claude-view/:nodeId`). The server stops
// the running process and pushes the node with its new kind to every window (`t:'canvas'`, applied by
// workspaceCanvasPush), so the response only matters when it refuses. State lives in the node's own
// chrome, so one node switching never disables another.
import { useCallback, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { ToolbarButton } from '@/vscode/register'
import { cn } from '@/lib/utils'
import { VscodeNotification } from '../components/vscode/vscodeNotification'
import type { AgentId, AgentStatus, Pane } from '../../shared/workspace'
import { useLiveSettings } from '../useSettings'
import { leafIds, rootPane } from '../paneTree'

export type ClaudeView = 'chat' | 'terminal'
export const CLAUDE_VIEW_PATH = '/api/claude-view'

export const CLAUDE_VIEW_TEXT = {
  chat: 'Open as chat',
  terminal: 'Open as terminal',
  busy: 'Claude is working. Switch when it finishes.',
  switching: 'Switching view…',
  failedTitle: 'Could not switch view',
  network: 'Could not switch view. Try again.',
} as const

/** Plain text per refusal code; the server's `hint` wins when it sends one. */
const CODE_TEXT: Record<string, string> = {
  node_not_found: 'This node is not on the server yet. Wait for the board to save, then try again.',
  not_claude: 'Only Claude nodes can switch view.',
  split_terminal: 'Close the split panes first, then switch.',
  central_worker: 'Central runs this node, so its view cannot change.',
  busy: 'Claude is working. Switch when it finishes, or stop it first.',
}

export type ClaudeViewResult = { ok: true } | { ok: false; message: string }

/** Ask the server to switch node `nodeId` to view `to`; never rejects, a refusal carries user text. */
export async function switchClaudeView(nodeId: string, to: ClaudeView): Promise<ClaudeViewResult> {
  let res: Response
  try {
    res = await fetch(`${CLAUDE_VIEW_PATH}/${encodeURIComponent(nodeId)}`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ to }),
    })
  } catch (e) {
    console.error(`switch claude view node ${nodeId} to ${to}:`, e)
    return { ok: false, message: CLAUDE_VIEW_TEXT.network }
  }
  // A non-JSON body (proxy error page) leaves only the status to go on.
  const body = (await res.json().catch(() => null)) as { ok?: unknown; code?: unknown; hint?: unknown } | null
  if (res.ok && body?.ok === true) return { ok: true }
  const hint = typeof body?.hint === 'string' && body.hint ? body.hint : undefined
  const code = typeof body?.code === 'string' ? body.code : `http_${res.status}`
  console.warn(`switch claude view node ${nodeId} to ${to} refused: ${res.status} ${code}`)
  return { ok: false, message: hint ?? CODE_TEXT[code] ?? CLAUDE_VIEW_TEXT.network }
}

/** One node's switch: `switching` while the request runs, `error` until the toast is closed. */
export function useClaudeViewSwitch(nodeId: string, to: ClaudeView) {
  const [switching, setSwitching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(false)
  const run = useCallback(() => {
    if (inFlight.current) return
    inFlight.current = true
    setSwitching(true)
    setError(null)
    void switchClaudeView(nodeId, to)
      .then((r) => { if (!r.ok) setError(r.message) })
      .finally(() => { inFlight.current = false; setSwitching(false) })
  }, [nodeId, to])
  return { switching, run, error, dismiss: () => setError(null) }
}

/** Mid-turn or held on a permission prompt (the server's own busy set); 'waiting' is the idle state after Stop (hookStatus.ts). */
const TERMINAL_BUSY: ReadonlySet<AgentStatus | undefined> = new Set<AgentStatus | undefined>(['working', 'blocked'])

/** "Open as chat" of an AgentNode: only for a single-pane Claude terminal while Claude is enabled. */
export function ClaudeTerminalViewButton({ nodeId, agentId, panes, status }: { nodeId: string; agentId?: AgentId; panes?: Pane; status?: AgentStatus }): ReactNode {
  const { disabledAgents } = useLiveSettings()
  if (agentId !== 'claude' || disabledAgents.includes('claude') || leafIds(rootPane(nodeId, panes)).length !== 1) return null
  return <ClaudeViewButton nodeId={nodeId} to="chat" busy={TERMINAL_BUSY.has(status)} />
}

/** Header button (NodeChrome `extraHeader`) that switches this Claude node to `to`, plus its error toast. */
export function ClaudeViewButton({ nodeId, to, busy }: { nodeId: string; to: ClaudeView; busy: boolean }): ReactNode {
  const { switching, run, error, dismiss } = useClaudeViewSwitch(nodeId, to)
  const off = busy || switching
  const tip = switching ? CLAUDE_VIEW_TEXT.switching : busy ? CLAUDE_VIEW_TEXT.busy : CLAUDE_VIEW_TEXT[to]
  const icon = switching ? 'loading codicon-modifier-spin' : to === 'chat' ? 'comment-discussion' : 'terminal'
  return (
    <>
      {/* vscode-toolbar-button has no `disabled`: aria-disabled + the guard below, like Maximize. The
          strings are explicit: React writes `true` on a custom element as "", which ARIA reads as false.
          Dimmed inline, not with pointer-events off, so the busy tooltip still shows on hover. */}
      <ToolbarButton
        className="nodrag" label={CLAUDE_VIEW_TEXT[to]} title={tip} data-title={tip} data-claude-view={to}
        aria-disabled={off ? 'true' : undefined} aria-busy={switching ? 'true' : undefined}
        style={off ? { opacity: 0.4 } : undefined}
        onClick={() => { if (!off) run() }}
      ><span className={cn('codicon', `codicon-${icon}`)} aria-hidden="true" /></ToolbarButton>
      {error && (
        <VscodeNotification id={`claude-view-${nodeId}`} severity="warning" title={CLAUDE_VIEW_TEXT.failedTitle} message={error} onClose={dismiss} />
      )}
    </>
  )
}
