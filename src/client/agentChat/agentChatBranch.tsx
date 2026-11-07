// Edit a sent message and Rewind to here (Claude Code "Rewind with checkpoints") for the agent chat
// view. Edit puts the message text back in the composer; the next send forks the conversation before
// that message (POST fork). Rewind first asks the server for a dry run (which files would change), then
// rewinds after the user confirms (POST rewind). Both are refused by the server while a turn runs.
import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import type { AgentChatRewindResult } from '../../shared/agentChat.wire'
import type { AgentChatTransport } from './agentChatTransport'
import { why } from './useAgentChatControls'
import './agentChatBranch.css'

/** What Claude Code's checkpoints cannot restore (code.claude.com agent-sdk/file-checkpointing, Limitations). */
export const REWIND_LIMITS = 'Only edits Claude made with its Write, Edit and NotebookEdit tools are restored. Changes from Bash commands and from subagents are not undone, and the conversation stays as it is.'

export interface ComposerSeed { text: string; key: number }

/** Edit + rewind state of one view. */
export function useAgentChatBranch() {
  const [editing, setEditing] = useState<{ id: string; seed: ComposerSeed } | null>(null)
  const [rewindId, setRewindId] = useState<string | null>(null)
  // Stable callbacks: the thread's actions object is memoized on them.
  const fns = useMemo(() => ({
    edit: (id: string, text: string) => { setRewindId(null); setEditing((e) => ({ id, seed: { text, key: (e?.seed.key ?? 0) + 1 } })) },
    cancelEdit: () => setEditing(null),
    rewind: (id: string) => { setEditing(null); setRewindId(id) },
    closeRewind: () => setRewindId(null),
  }), [])
  return { editing, rewindId, ...fns }
}

export function EditBanner({ onCancel }: { onCancel: () => void }) {
  return (
    <div className="agent-chat-branch" role="status" aria-label="Editing a message">
      <span className="codicon codicon-edit" aria-hidden="true" />
      <span>Editing a sent message. Sending starts a new branch of the conversation from there; the original stays in History.</span>
      <Button variant="ghost" size="xs" onClick={onCancel}>Cancel</Button>
    </div>
  )
}

type Phase = { k: 'loading' } | { k: 'preview'; r: AgentChatRewindResult } | { k: 'running'; r: AgentChatRewindResult } | { k: 'done'; r: AgentChatRewindResult } | { k: 'error'; message: string }

const files = (n: number): string => `${n} file${n === 1 ? '' : 's'}`

/** Dry run on open, then confirm; `messageId` = the user message to rewind the files to (its state before it). */
export function RewindPanel({ transport, messageId, onClose }: { transport: AgentChatTransport; messageId: string; onClose: () => void }) {
  const [phase, setPhase] = useState<Phase>({ k: 'loading' })
  useEffect(() => {
    let live = true
    setPhase({ k: 'loading' })
    transport.rewind(messageId, true).then(
      (r) => { if (live) setPhase(r.canRewind ? { k: 'preview', r } : { k: 'error', message: r.error || 'There is no checkpoint for this message.' }) },
      (err: unknown) => { if (live) setPhase({ k: 'error', message: why(err) }) },
    )
    return () => { live = false }
  }, [transport, messageId])
  const confirm = (r: AgentChatRewindResult): void => {
    setPhase({ k: 'running', r })
    transport.rewind(messageId, false).then(
      (done) => setPhase(done.canRewind ? { k: 'done', r: done } : { k: 'error', message: done.error || 'The files could not be rewound.' }),
      (err: unknown) => setPhase({ k: 'error', message: why(err) }),
    )
  }
  const preview = phase.k === 'preview' || phase.k === 'running' ? phase.r : undefined
  return (
    <section className="agent-chat-rewind" aria-label="Rewind files">
      <div className="agent-chat-rewind__head">
        <span className="codicon codicon-discard" aria-hidden="true" />
        <span className="agent-chat-rewind__title">Rewind files to this message</span>
        <IconButton label="Close rewind" size="icon-xs" onClick={onClose}><span className="codicon codicon-close" aria-hidden="true" /></IconButton>
      </div>
      {phase.k === 'loading' && <p role="status">Checking which files would change…</p>}
      {phase.k === 'error' && <p className="agent-chat-rewind__error" role="alert">{`Cannot rewind: ${phase.message}`}</p>}
      {phase.k === 'done' && (
        <p role="status">{`Rewound ${files(phase.r.filesChanged.length)}.${phase.r.skippedLinks ? ` ${files(phase.r.skippedLinks)} left alone (links or unsafe paths).` : ''}`}</p>
      )}
      {preview && (
        <>
          {preview.filesChanged.length === 0
            ? <p role="status">No file changed since this message; nothing to rewind.</p>
            : (
              <>
                <p role="status">{`${files(preview.filesChanged.length)} will go back to how ${preview.filesChanged.length === 1 ? 'it was' : 'they were'} before this message (+${preview.insertions} −${preview.deletions} lines):`}</p>
                <ul className="agent-chat-rewind__files">{preview.filesChanged.map((f) => <li key={f}>{f}</li>)}</ul>
              </>
            )}
          <p className="agent-chat-rewind__limits">{REWIND_LIMITS}</p>
          <div className="agent-chat-rewind__actions">
            <Button variant="secondary" size="xs" onClick={onClose}>Cancel</Button>
            <Button size="xs" disabled={phase.k === 'running' || preview.filesChanged.length === 0} onClick={() => confirm(preview)}>
              {phase.k === 'running' ? 'Rewinding…' : 'Rewind files'}
            </Button>
          </div>
        </>
      )}
    </section>
  )
}
