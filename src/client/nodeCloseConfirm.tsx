// The one confirm gate for a USER closing nodes. Every close button, the tab strip, the sessions
// panel and the Delete key end in React Flow `deleteElements`, which awaits `onBeforeDelete`
// (`beforeNodeDelete` below) before it removes anything — so one gate covers them all. The
// off-canvas close (a node of a workspace that is not mounted) calls `confirmNodeClose` itself.
//
// System removals never come here: a workspace switch, undo/redo, a template rebuild or a sync from
// the server replace the board through `setNodes`, which React Flow does not route through
// `onBeforeDelete`. Edge-only deletes (an edge double-click, Delete on a selected cable) pass
// straight through: there is no node in them.
//
// Wording and keyboard rules copy nodeterm's node delete confirm (Canvas.tsx `deleteSelectionCommand`,
// components/ConfirmDialog): the dialog names what ends, and focus starts on Cancel so a stray
// Enter never closes a node. nodeterm has no "Don't ask again" for this, so neither does webterm.
import { useEffect, useRef, useSyncExternalStore } from 'react'
import type { Node, OnBeforeDelete } from '@xyflow/react'
import { VscodeDialog } from './components/vscode/vscodeDialog'
import { arrangeDialogButtons } from './components/vscode/vscodeDialogButtons'
import { Button } from './components/ui/button'

/** What the dialog needs of a node: its kind (`type`) and its title. */
export type ClosableNode = Pick<Node, 'type' | 'data'>

/** Display name and what ends, for one node (`ends`) and for several (`many`), per node kind.
 *  A kind missing here has nothing running: it only leaves the canvas. */
const KIND_COPY: Record<string, { name: string; ends: string; many: string }> = {
  terminal: { name: 'Terminal', ends: 'Its terminal session and any process running in it will end.', many: 'Terminal sessions and their running processes will end.' },
  agent: { name: 'Agent', ends: 'Its agent session will end, interrupting anything it is running.', many: 'Agent sessions will end, interrupting anything they are running.' },
  agentChat: { name: 'Agent chat', ends: 'Its chat session will end.', many: 'Agent chat sessions will end.' },
  editor: { name: 'Editor', ends: 'Any unsaved changes in the editor will be lost.', many: 'Unsaved changes in editors will be lost.' },
  browser: { name: 'Browser', ends: 'Its browser page will close.', many: 'Browser pages will close.' },
}

/** Title and body for closing `nodes` (one or more). */
export function nodeCloseCopy(nodes: readonly ClosableNode[]): { title: string; body: string } {
  if (nodes.length === 1) {
    const n = nodes[0]
    const kind = KIND_COPY[n.type ?? '']
    const label = (n.data as { title?: string } | undefined)?.title || kind?.name || 'this node'
    return { title: `Close “${label}”?`, body: kind?.ends ?? 'It will be removed from the canvas.' }
  }
  const ends = [...new Set(nodes.map((n) => KIND_COPY[n.type ?? '']?.many).filter(Boolean))]
  return { title: `Close ${nodes.length} nodes?`, body: ends.length ? ends.join(' ') : 'They will be removed from the canvas.' }
}

interface Pending { nodes: readonly ClosableNode[]; resolve: (ok: boolean) => void }
/** The request being answered: set synchronously, so the one-at-a-time guard has no gap. */
let pending: Pending | null = null
/** The request on screen. Lags `pending` by one task when opening: the × click that asks also
 *  selects the node, and a selected terminal focuses its xterm in an effect of that same commit.
 *  Opened in the same commit, the dialog loses its Cancel focus to the terminal behind it. */
let shown: Pending | null = null
const listeners = new Set<() => void>()
const emit = (): void => { shown = pending; for (const l of listeners) l() }
const subscribe = (l: () => void): (() => void) => { listeners.add(l); return () => { listeners.delete(l) } }

/** Ask the user before closing `nodes`. Resolves true to close. Only one dialog at a time: a request
 *  made while one is open is refused (false) instead of swapping the nodes under the open dialog. */
export function confirmNodeClose(nodes: readonly ClosableNode[]): Promise<boolean> {
  if (!nodes.length) return Promise.resolve(true)
  if (pending) return Promise.resolve(false)
  return new Promise((resolve) => { pending = { nodes, resolve }; setTimeout(emit, 0) })
}

/** Answer the open dialog, if any. Also called when the canvas unmounts (a workspace switch). */
export function answerNodeClose(ok: boolean): void {
  const p = pending
  if (!p) return
  pending = null
  emit()
  p.resolve(ok)
}

/** React Flow `onBeforeDelete`: nodes in the delete → confirm; edges alone → straight through. */
export const beforeNodeDelete: OnBeforeDelete = ({ nodes }) => confirmNodeClose(nodes)

/** Cancels an open close dialog when the canvas it belongs to unmounts. */
export function useCancelNodeCloseOnUnmount(): void {
  useEffect(() => () => answerNodeClose(false), [])
}

/** The dialog. Mounted once (App.hosts.tsx); renders nothing until a close is requested. */
export function NodeCloseConfirmHost(): React.JSX.Element | null {
  const req = useSyncExternalStore(subscribe, () => shown)
  const cancelRef = useRef<HTMLButtonElement>(null)
  if (!req) return null
  const { title, body } = nodeCloseCopy(req.nodes)
  const close = <Button key="close" variant="destructive" onClick={() => answerNodeClose(true)}>Close</Button>
  const cancel = <Button key="cancel" ref={cancelRef} variant="secondary" onClick={() => answerNodeClose(false)}>Cancel</Button>
  return (
    <VscodeDialog
      open onOpenChange={(open) => { if (!open) answerNodeClose(false) }}
      title={title} description={body} width={420} className="node-close-confirm"
      // nodeterm: the destructive button never takes focus, so a stray Enter cannot close a node.
      initialFocus={cancelRef}
      footer={arrangeDialogButtons([close, cancel], 1)}
    />
  )
}
