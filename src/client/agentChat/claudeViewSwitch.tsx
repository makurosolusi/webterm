// Chat <-> terminal view switch of one Claude node (`POST /api/claude-view/:nodeId`). The server stops
// the running process and pushes the node with its new kind to every window (`t:'canvas'`, applied by
// workspaceCanvasPush), so the response only matters when it refuses. State lives in the node's own
// chrome, so one node switching never disables another.
import { useCallback, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { IconTooltip } from '@/components/ui/icon-button'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { VscodeNotification } from '../components/vscode/vscodeNotification'
import type { AgentId, AgentStatus, Pane } from '../../shared/workspace'
import { useLiveSettings } from '../useSettings'
import { leafIds, rootPane } from '../paneTree'
import { SettingsSegmented } from '../SettingsControls'

export type ClaudeView = 'chat' | 'terminal'
export const CLAUDE_VIEW_PATH = '/api/claude-view'

export const CLAUDE_VIEW_TEXT = {
  group: 'View',
  terminal: 'Terminal',
  chat: 'Chat',
  toTerminal: 'Show this Claude session as a terminal. Claude restarts; the conversation carries over.',
  toChat: 'Show this Claude session as a chat. Claude restarts; the conversation carries over.',
  busy: 'Claude is working. Switch when it finishes.',
  confirmTitle: (to: ClaudeView) => `Stop Claude and switch to ${to === 'chat' ? 'Chat' : 'Terminal'}?`,
  confirmBody: 'Claude is in the middle of a turn. Switching stops it now and restarts Claude in the other view; the conversation so far carries over.',
  confirmAction: 'Stop and switch',
  cancel: 'Cancel',
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

export type ClaudeViewResult = { ok: true } | { ok: false; message: string; code: string }

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
    return { ok: false, message: CLAUDE_VIEW_TEXT.network, code: 'network' }
  }
  // A non-JSON body (proxy error page) leaves only the status to go on.
  const body = (await res.json().catch(() => null)) as { ok?: unknown; code?: unknown; hint?: unknown } | null
  if (res.ok && body?.ok === true) return { ok: true }
  const hint = typeof body?.hint === 'string' && body.hint ? body.hint : undefined
  const code = typeof body?.code === 'string' ? body.code : `http_${res.status}`
  console.warn(`switch claude view node ${nodeId} to ${to} refused: ${res.status} ${code}`)
  return { ok: false, message: hint ?? CODE_TEXT[code] ?? CLAUDE_VIEW_TEXT.network, code }
}

/** Wait before the one retry of a switch sent right after Stop: the close travels on the socket, the switch over HTTP. */
export const STOP_RETRY_MS = 500
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** One node's switch: `switching` while the request runs, `error` until the toast is closed. */
export function useClaudeViewSwitch(nodeId: string, to: ClaudeView) {
  const [switching, setSwitching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(false)
  /** `afterStop`: a busy refusal is retried once, since the server may not have seen the Stop yet. */
  const run = useCallback((afterStop = false) => {
    if (inFlight.current) return
    inFlight.current = true
    setSwitching(true)
    setError(null)
    void (async () => {
      let r = await switchClaudeView(nodeId, to)
      // ponytail: one fixed retry; a server-side "stop then switch" would remove the race entirely.
      if (!r.ok && afterStop && r.code === 'busy') { await sleep(STOP_RETRY_MS); r = await switchClaudeView(nodeId, to) }
      if (!r.ok) setError(r.message)
    })().finally(() => { inFlight.current = false; setSwitching(false) })
  }, [nodeId, to])
  return { switching, run, error, dismiss: () => setError(null) }
}

/** Mid-turn or held on a permission prompt (the server's own busy set); 'waiting' is the idle state after Stop (hookStatus.ts). */
const TERMINAL_BUSY: ReadonlySet<AgentStatus | undefined> = new Set<AgentStatus | undefined>(['working', 'blocked'])

/** [Terminal | Chat] of an AgentNode: only for a single-pane Claude terminal while Claude is enabled. */
export function ClaudeTerminalViewToggle({ nodeId, agentId, panes, status, onStopTurn }: {
  nodeId: string; agentId?: AgentId; panes?: Pane; status?: AgentStatus
  /** Ends the running turn (the node's Stop); lets a busy node switch after a confirm. */
  onStopTurn?: () => void
}): ReactNode {
  const { disabledAgents } = useLiveSettings()
  if (agentId !== 'claude' || disabledAgents.includes('claude') || leafIds(rootPane(nodeId, panes)).length !== 1) return null
  return <ClaudeViewToggle nodeId={nodeId} view="terminal" busy={TERMINAL_BUSY.has(status)} onStopTurn={onStopTurn} />
}

/**
 * Header segmented control (NodeChrome `extraHeader`) showing this Claude node's view; choosing the
 * other view switches it. While a turn runs the switch needs `onStopTurn` and a confirm, else it is
 * disabled with the reason as its tooltip.
 */
export function ClaudeViewToggle({ nodeId, view, busy, onStopTurn }: { nodeId: string; view: ClaudeView; busy: boolean; onStopTurn?: () => void }): ReactNode {
  const to: ClaudeView = view === 'chat' ? 'terminal' : 'chat'
  const { switching, run, error, dismiss } = useClaudeViewSwitch(nodeId, to)
  const [confirming, setConfirming] = useState(false)
  const blocked = busy && !onStopTurn
  const hint = switching ? CLAUDE_VIEW_TEXT.switching : blocked ? CLAUDE_VIEW_TEXT.busy : to === 'chat' ? CLAUDE_VIEW_TEXT.toChat : CLAUDE_VIEW_TEXT.toTerminal
  const choose = () => { if (busy) setConfirming(true); else run() }
  return (
    <>
      <IconTooltip label={hint}>
        <span className="claude-view-toggle nodrag" aria-busy={switching || undefined} data-claude-view={view}>
          <SettingsSegmented
            ariaLabel={CLAUDE_VIEW_TEXT.group} value={view} disabled={switching || blocked}
            options={[{ value: 'terminal', label: CLAUDE_VIEW_TEXT.terminal }, { value: 'chat', label: CLAUDE_VIEW_TEXT.chat }]}
            onChange={choose}
          />
        </span>
      </IconTooltip>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>{CLAUDE_VIEW_TEXT.confirmTitle(to)}</AlertDialogTitle>
            <AlertDialogDescription>{CLAUDE_VIEW_TEXT.confirmBody}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{CLAUDE_VIEW_TEXT.cancel}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => { onStopTurn?.(); run(true) }}>{CLAUDE_VIEW_TEXT.confirmAction}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {error && (
        <VscodeNotification id={`claude-view-${nodeId}`} severity="warning" title={CLAUDE_VIEW_TEXT.failedTitle} message={error} onClose={dismiss} />
      )}
    </>
  )
}
