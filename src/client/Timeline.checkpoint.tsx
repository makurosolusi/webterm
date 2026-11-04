// Checkpoint lines of the Activity timeline (PLAN F3-c): wording for `checkpoint.*` events, the
// "not rewindable" labels, and the Rewind control (preview diff -> confirm -> restore).
//
// Imitated designs: Cursor checkpoints (click a checkpoint in the chat timeline, preview, restore
// files only) and Claude Code `/rewind` ("restore code"); the honesty labels follow rnd/04: effects
// outside the file system (web, MCP, browser, channels) and non-git folders cannot be rewound.
import { useState } from 'react'
import { TOKEN_HEADER } from './api'
import { peekToken } from './transportToken'
import { VscodeTooltip } from './components/vscode/vscodeTooltip'
import { getJson } from './Timeline.status'
import type { TimelineContext, TimelineEvent } from './Timeline.model'

export const CHECKPOINTS_URL = '/api/checkpoints'

type Rec = Record<string, unknown>
const rec = (v: unknown): Rec => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Rec) : {})

const REASON_TEXT: Record<string, string> = {
  prompt: 'before agent prompt', action: 'before Central action', halt: 'panic snapshot on Halt', rewind: 'before rewind (undo point)',
}
const NETWORK_TOOLS = new Set(['WebFetch', 'WebSearch'])

/** Workspace + seq a Rewind on this line targets; null for any other event. */
export function checkpointTarget(e: TimelineEvent): { workspaceId: string; seq: number } | null {
  const seq = rec(e.payload).seq
  return e.kind === 'checkpoint.created' && e.workspaceId && typeof seq === 'number' ? { workspaceId: e.workspaceId, seq } : null
}

/** Line text for `checkpoint.*` events; null = use the generic wording. */
export function checkpointText(e: TimelineEvent): string | null {
  const p = rec(e.payload)
  if (e.kind === 'checkpoint.created') return `Checkpoint #${String(p.seq)} ${REASON_TEXT[String(p.reason)] ?? ''}`.trim()
  if (e.kind === 'checkpoint.rewound') return `Rewound files to checkpoint #${String(p.seq)} (undo: #${String(p.undoSeq)})`
  if (e.kind === 'checkpoint.unavailable') return p.why === 'no_cwd' ? 'No checkpoint: workspace has no folder' : 'No checkpoint: workspace folder is not a git repository'
  return null
}

/** Why an event's effect cannot be undone by Rewind; null = nothing to flag. */
export function rewindLabel(e: TimelineEvent, ctx: TimelineContext): string | null {
  if (e.kind === 'checkpoint.unavailable') return 'Not rewindable: not a git repo'
  const family = e.kind.split('.')[0]
  if (family === 'browser' || family === 'channel') return 'Not rewindable: network side effect'
  const tool = rec(e.payload).toolName
  if ((e.kind === 'hook.PreToolUse' || e.kind === 'hook.PostToolUse') && typeof tool === 'string' && (NETWORK_TOOLS.has(tool) || tool.startsWith('mcp__'))) {
    return 'Not rewindable: network side effect'
  }
  if (e.kind === 'fs.change') {
    const dir = rec(e.payload).dir
    const inside = typeof dir === 'string' && ctx.workspaces.some((w) => { const c = w.cwd?.replace(/\/+$/, ''); return !!c && (dir === c || dir.startsWith(`${c}/`)) })
    if (!inside) return 'Not rewindable: outside any workspace'
  }
  return null
}

/** Warning chip for `rewindLabel`; the hover says what Rewind does and does not cover. */
export function NotRewindableChip({ label }: { label: string }): React.JSX.Element {
  return (
    <VscodeTooltip content="Rewind restores files of git workspaces only. Network calls, messages, browser actions and files outside the workspace stay as they are.">
      <span className="timeline-norewind" tabIndex={0}>{label}</span>
    </VscodeTooltip>
  )
}

interface FileChange { status: 'A' | 'M' | 'D' | 'T'; path: string }
interface Preview { files: FileChange[]; patch: string; truncated: boolean }
const VERB: Record<FileChange['status'], string> = { A: 'restore', M: 'revert', T: 'revert', D: 'delete' }

async function postRewind(workspaceId: string, seq: number): Promise<{ written: number; deleted: number; undoSeq: number }> {
  const token = peekToken()
  const res = await fetch(`${CHECKPOINTS_URL}/rewind`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token === '' ? {} : { [TOKEN_HEADER]: token }) },
    body: JSON.stringify({ workspace: workspaceId, seq }),
  })
  if (!res.ok) throw new Error(`POST ${CHECKPOINTS_URL}/rewind -> ${res.status}`)
  return res.json() as Promise<{ written: number; deleted: number; undoSeq: number }>
}

type Stage = { at: 'idle' } | { at: 'loading' } | { at: 'confirm'; preview: Preview } | { at: 'done'; text: string } | { at: 'error'; text: string }

/** "Rewind" on a checkpoint line: preview the diff, confirm, restore (HEAD is never moved). */
export function RewindControl({ workspaceId, seq }: { workspaceId: string; seq: number }): React.JSX.Element {
  const [stage, setStage] = useState<Stage>({ at: 'idle' })
  const fail = (err: unknown): void => setStage({ at: 'error', text: err instanceof Error ? err.message : String(err) })
  const open = (): void => {
    setStage({ at: 'loading' })
    getJson(`${CHECKPOINTS_URL}/preview?workspace=${encodeURIComponent(workspaceId)}&seq=${seq}`)
      .then((p) => setStage({ at: 'confirm', preview: p as Preview }), fail)
  }
  const confirm = (): void => {
    setStage({ at: 'loading' })
    postRewind(workspaceId, seq).then(
      (r) => setStage({ at: 'done', text: `Rewound: ${r.written} restored, ${r.deleted} deleted. Undo with checkpoint #${r.undoSeq}.` }),
      fail,
    )
  }
  if (stage.at === 'idle' || stage.at === 'loading') {
    return <button type="button" className="timeline-rewind" disabled={stage.at === 'loading'} onClick={open}>{stage.at === 'loading' ? 'Loading…' : 'Rewind'}</button>
  }
  if (stage.at === 'done' || stage.at === 'error') {
    return <span className="timeline-rewind-note" role="status" data-state={stage.at}>{stage.text}</span>
  }
  const { files, patch, truncated } = stage.preview
  return (
    <div className="timeline-rewind-dialog" role="dialog" aria-label={`Rewind to checkpoint #${seq}`}>
      {files.length === 0
        ? <p>Files already match checkpoint #{seq}; nothing to change.</p>
        : <ul>{files.map((f) => <li key={f.path}><span className="timeline-rewind-verb">{VERB[f.status]}</span> {f.path}</li>)}</ul>}
      {patch && <pre className="timeline-rewind-patch">{patch}{truncated ? '\n… (diff truncated)' : ''}</pre>}
      <p className="timeline-rewind-warn">Files ignored by .gitignore and secret files (.env, keys) are not restored. Git HEAD, branch and staging stay as they are. A checkpoint of the current files is taken first, so this can be undone.</p>
      <div className="timeline-rewind-actions">
        <button type="button" onClick={confirm} disabled={files.length === 0}>Rewind files</button>
        <button type="button" onClick={() => setStage({ at: 'idle' })}>Cancel</button>
      </div>
    </div>
  )
}
