// Diff node (plan I1-b, ide-parity G1): the working-tree diff of a repo on the canvas, so reviewing
// what an agent wrote does not need another IDE. Imitates Orca's Changes mode
// (`components/editor/ChangesModeView.tsx`: binary/identical notices, HEAD vs working copy) and
// Annotate AI Diff (`components/diff-comments/`, `DiffNotesSendMenu.tsx`: notes per line, sent as one
// prompt), plus VS Code's working-set Keep/Undo per change.
//
// Root = the cwd of the agent wired to it, else the node's own `cwd` (the workspace folder). A wired agent also gets the
// notes, and its turn ending (`waiting`/`done`) refreshes the diff.
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { Handle, Position, useReactFlow, useStore, type NodeProps } from '@xyflow/react'
import { NodeLayoutResizer, NodeResizeToggle } from './nodeResize/NodeLayoutResizer'
import { Button as VscodeButton, ToolbarButton, ToolbarContainer } from '@/vscode/register'
import { IconTooltip } from '@/components/ui/icon-button'
import type { GitChange, GitChangeStatus, GitFileDiff } from '../server/gitDiff.types'
import { DIFF_NOTE_BODY_MAX, DIFF_NOTES_MAX, validDiffNotes, type AgentStatus } from '../shared/workspace'
import { fetchDiffList, fetchFileDiff, undoHunk } from './DiffNode.api'
import { useDiffEditor } from './DiffNode.editor'
import { enqueueNotes, sendRefusal, type DiffNote } from './DiffNode.notes'
import { randomId } from './randomId'
import { ScmPanel } from './ScmPanel'
import { getStatus, subscribeStatus } from './ws'
import './DiffNode.css'

const STATUS_LETTER: Record<GitChangeStatus, string> = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R', untracked: 'U' }
const TURN_ENDED: readonly (AgentStatus | undefined)[] = ['waiting', 'done']

/** `agentId\0cwd` of the first agent node wired to `id` (a string, so the store selector stays stable). */
function useWiredAgent(id: string): { id: string; cwd: string } | null {
  const key = useStore((s) => {
    for (const e of s.edges) {
      const other = e.source === id ? e.target : e.target === id ? e.source : null
      const d = other ? (s.nodeLookup.get(other)?.data as { agentId?: string; cwd?: string } | undefined) : undefined
      if (other && d?.agentId) return `${other}\0${d.cwd ?? ''}`
    }
    return ''
  })
  return useMemo(() => (key ? { id: key.split('\0')[0], cwd: key.split('\0')[1] } : null), [key])
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function DiffNode({ id, data, selected }: NodeProps) {
  const rf = useReactFlow()
  const d = data as { cwd?: string; color?: string; title?: string }
  const swatch = d.color ?? '#0a84ff'
  const agent = useWiredAgent(id)
  // ide-parity G1: wiring an agent makes the diff follow that agent's cwd/worktree.
  const root = agent?.cwd || d.cwd || ''

  const [files, setFiles] = useState<GitChange[]>([])
  const [nextOffset, setNextOffset] = useState<number | null>(null)
  const [total, setTotal] = useState(0)
  const [active, setActive] = useState<string | null>(null)
  const [file, setFile] = useState<GitFileDiff | null>(null)
  const [kept, setKept] = useState<Set<string>>(new Set())
  // Notes live on the node (`WsNode.diffNotes`), read from the store so every write is seen at once.
  const rawNotes = useStore((s) => (s.nodeLookup.get(id)?.data as { diffNotes?: unknown } | undefined)?.diffNotes)
  const notes = useMemo(() => validDiffNotes(rawNotes), [rawNotes])
  const setNotes = useCallback((f: (ns: DiffNote[]) => DiffNote[]) => {
    rf.updateNodeData(id, (n) => ({ diffNotes: f(validDiffNotes((n.data as { diffNotes?: unknown }).diffNotes)) }))
  }, [rf, id])
  const [draft, setDraft] = useState('')
  const [msg, setMsg] = useState('')
  const [status, setStatus] = useState<AgentStatus | undefined>(agent ? getStatus(agent.id) : undefined)

  const loadFile = useCallback(async (path: string | null) => {
    if (!root || !path) { setFile(null); return }
    try { setFile(await fetchFileDiff(root, path)) } catch (e) { setFile(null); setMsg(errText(e)) }
  }, [root])

  const loadList = useCallback(async (offset = 0) => {
    if (!root) return
    try {
      const page = await fetchDiffList(root, offset)
      setFiles((prev) => (offset === 0 ? page.files : [...prev, ...page.files]))
      setNextOffset(page.nextOffset)
      setTotal(page.total)
      setMsg('')
    } catch (e) {
      setMsg(errText(e))
    }
  }, [root])

  const activeRef = useRef(active)
  activeRef.current = active
  const refresh = useCallback(() => { void loadList(0); void loadFile(activeRef.current) }, [loadList, loadFile])
  useEffect(() => { refresh() }, [refresh])

  useEffect(() => {
    if (!agent) return
    setStatus(getStatus(agent.id))
    return subscribeStatus((nid, st) => {
      if (nid !== agent.id) return
      setStatus(st)
      if (TURN_ENDED.includes(st)) refresh()
    })
  }, [agent, refresh])

  const host = useRef<HTMLDivElement>(null)
  const sides = useMemo(() => (file && !file.binary && !file.sensitive && !file.truncated ? { path: file.path, original: file.original, modified: file.modified } : null), [file])
  const notedLines = useMemo(() => notes.filter((n) => n.path === file?.path).map((n) => n.line), [notes, file])
  const editor = useDiffEditor(host, sides, notedLines)

  const open = (path: string) => { setActive(path); void loadFile(path) }
  const onUndo = async (hunkId: string, header: string) => {
    if (!file || !window.confirm(`Undo this change in ${file.path}?\n${header}\nThe working-tree lines go back to HEAD.`)) return
    try { await undoHunk(root, file.path, hunkId); refresh() } catch (e) { setMsg(errText(e)) }
  }
  const addNote = () => {
    if (!file || !draft.trim()) return
    if (notes.length >= DIFF_NOTES_MAX) { setMsg(`At most ${DIFF_NOTES_MAX} notes; send some first.`); return }
    setNotes((ns) => [...ns, { id: randomId(), path: file.path, line: editor.line, body: draft.trim().slice(0, DIFF_NOTE_BODY_MAX) }])
    setDraft('')
  }
  const onSend = async () => {
    const refusal = sendRefusal(agent?.id ?? null, notes.length)
    if (refusal || !agent) { setMsg(refusal ?? ''); return }
    const batch = notes
    // Through the server outbox: queued while the agent is busy, typed once its turn ends.
    try { await enqueueNotes(agent.id, batch) } catch (e) { setMsg(errText(e)); return }
    const sent = new Set(batch.map((n) => n.id))
    setNotes((ns) => ns.filter((n) => !sent.has(n.id)))
    setMsg(`Queued ${batch.length} note${batch.length === 1 ? '' : 's'} for the agent; it gets them as soon as its prompt is free.`)
  }

  const body = () => {
    if (!file) return <span className="diff-node__notice">{root ? 'Select a file to see its changes.' : ''}</span>
    if (file.sensitive) return <span className="diff-node__notice">Contents hidden: this file looks like a secret.</span>
    if (file.binary) return <span className="diff-node__notice">Binary file. Text diff is unavailable for this file.</span>
    if (file.truncated) return <span className="diff-node__notice">File too large to diff here.</span>
    return null
  }
  const hunks = file?.hunks.filter((h) => !kept.has(h.id)) ?? []
  // The click's own refusal doubles as the hint, so the tooltip says what the click will do.
  const sendTip = sendRefusal(agent?.id ?? null, notes.length) ?? 'Send all notes to the wired agent as one message'

  return (
    <>
      <NodeLayoutResizer minWidth={420} minHeight={260} color={swatch} />
      <div className={`term-node diff-node${selected ? ' term-node--selected' : ''}`} style={{ '--node-swatch': swatch } as CSSProperties}>
        <div className="node-header">
          <span className="node-title diff-node__title" title={root}>
            <span className="codicon codicon-git-compare" aria-hidden="true" />
            {d.title || 'Changes'}
            <span className="diff-node__desc">{root ? `${total} file${total === 1 ? '' : 's'}` : ''}</span>
          </span>
          <span className="diff-node__spacer" />
          <NodeResizeToggle />
          <ToolbarContainer className="nodrag diff-node__actions">
            <IconTooltip label={sendTip}>
              <VscodeButton secondary onClick={() => void onSend()}>
                Send to agent ({notes.length})
              </VscodeButton>
            </IconTooltip>
            <IconTooltip label="Reload the changed files and the open diff">
              <ToolbarButton label="Refresh" onClick={refresh}><span className="codicon codicon-refresh" aria-hidden="true" /></ToolbarButton>
            </IconTooltip>
            <IconTooltip label="Remove this node from the canvas">
              <ToolbarButton label="Close" onClick={() => void rf.deleteElements({ nodes: [{ id }] })}><span className="codicon codicon-close" aria-hidden="true" /></ToolbarButton>
            </IconTooltip>
          </ToolbarContainer>
        </div>
        {msg && <div className="diff-node__msg nodrag" role="status">{msg}</div>}
        {root && <ScmPanel root={root} agentId={agent?.id ?? null} onChanged={refresh} />}
        <div className="node-body diff-node__body nodrag nowheel nokey">
          {!root ? (
            <span className="diff-node__notice">Wire an agent to this node, or open it on a workspace folder, to see changes.</span>
          ) : (
            <>
              <ul className="diff-node__files" aria-label="Changed files">
                {files.length === 0 && <li className="diff-node__notice">No uncommitted changes.</li>}
                {files.map((f) => (
                  <li key={f.path}>
                    <IconTooltip label={`Show changes in ${f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}`} side="right">
                      <button type="button" className={`diff-node__file${f.path === active ? ' diff-node__file--active' : ''}`} onClick={() => open(f.path)}>
                        <span className={`diff-node__status diff-node__status--${f.status}`}>{STATUS_LETTER[f.status]}</span>
                        <span className="diff-node__path">{f.path}</span>
                        {f.sensitive && <span className="codicon codicon-lock" aria-label="Secret file, contents hidden" />}
                      </button>
                    </IconTooltip>
                  </li>
                ))}
                {nextOffset !== null && <li><VscodeButton secondary onClick={() => void loadList(nextOffset)}>Load more</VscodeButton></li>}
              </ul>
              <div className="diff-node__main">
                {body()}
                {editor.error && <span className="diff-node__notice">{editor.error}</span>}
                <div className="diff-node__monaco" ref={host} hidden={!sides} />
                {hunks.length > 0 && (
                  <ul className="diff-node__hunks" aria-label="Changes in file">
                    {hunks.map((h) => (
                      <li key={h.id} className="diff-node__hunk">
                        <code>{h.header}</code>
                        <IconTooltip label="Keep this change (hide it from the review)">
                          <VscodeButton secondary onClick={() => setKept((s) => new Set(s).add(h.id))}>Keep</VscodeButton>
                        </IconTooltip>
                        {file?.undoable && (
                          <IconTooltip label="Undo this change in the working tree">
                            <VscodeButton secondary onClick={() => void onUndo(h.id, h.header)}>Undo</VscodeButton>
                          </IconTooltip>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {sides && (
                  <div className="diff-node__composer">
                    <textarea aria-label={`Note on line ${editor.line}`} placeholder={`Note on line ${editor.line} of ${sides.path}`} maxLength={DIFF_NOTE_BODY_MAX} value={draft} onChange={(e) => setDraft(e.target.value)} />
                    <VscodeButton secondary disabled={!draft.trim()} onClick={addNote}>Add note</VscodeButton>
                  </div>
                )}
                {notes.length > 0 && (
                  <ul className="diff-node__notes" aria-label="Review notes">
                    {notes.map((n) => (
                      <li key={n.id}>
                        <span className="diff-node__note-loc">{n.path}:{n.line}</span> {n.body}
                        <IconTooltip label="Remove this note">
                          <button type="button" className="diff-node__note-del" aria-label="Remove note" onClick={() => setNotes((ns) => ns.filter((x) => x.id !== n.id))}>×</button>
                        </IconTooltip>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}
        </div>
        <Handle id="link-out" type="source" position={Position.Right} className="bridge-handle" />
        <Handle id="link-in" type="target" position={Position.Left} className="bridge-handle" />
      </div>
    </>
  )
}

export default memo(DiffNode)
