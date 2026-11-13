// Diff node (plan I1-b, ide-parity G1): the working-tree diff of a repo on the canvas, so reviewing
// what an agent wrote does not need another IDE. Imitates Orca's Changes mode
// (`components/editor/ChangesModeView.tsx`: binary/identical notices, HEAD vs working copy) and
// Annotate AI Diff (`components/diff-comments/`, `DiffNotesSendMenu.tsx`: notes per line, sent as one
// prompt), plus VS Code's working-set Keep/Undo per change.
//
// Root = the cwd of the agent wired to it, else the node's own `cwd` (the workspace folder). A wired agent also gets the
// notes, and its turn ending (`waiting`/`done`) refreshes the diff.
import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { Handle, Position, useReactFlow, useStore, type NodeProps } from '@xyflow/react'
import { NodeLayoutResizer } from './nodeResize/NodeLayoutResizer'
import NodeChrome, { termNodeClass } from './NodeChrome'
import { useNodeCollapse } from './nodeCollapse'
import { Button as VscodeButton, ToolbarButton, ToolbarContainer } from '@/vscode/register'
import { IconTooltip } from '@/components/ui/icon-button'
import { ActionResult, errorCause, useAction } from '@/components/ui/action'
import type { GitChange, GitChangeStatus, GitFileDiff } from '../server/gitDiff.types'
import { DIFF_NOTE_BODY_MAX, DIFF_NOTES_MAX, validDiffNotes, type AgentStatus, type Comment } from '../shared/workspace'
import { fetchDiffList, fetchFileDiff, undoHunk } from './DiffNode.api'
import { useDiffEditor } from './DiffNode.editor'
import { enqueueNotes, sendRefusal, type DiffNote } from './DiffNode.notes'
import { randomId } from './randomId'
import { getStatus, subscribeStatus } from './ws'

// The commit/stage panel loads with the first diff node; the node chrome and file list stay eager.
const ScmPanel = lazy(() => import('./ScmPanel').then((m) => ({ default: m.ScmPanel })))
import './DiffNode.css'
import { effectiveWrap, useWordWrap, useWrapChord, WordWrapButton, wrapChordLabel } from './editorWrap'
import { useNodeHost } from './tabLayout.context'
import TabNodeActions, { type TabAction } from './tabLayout.nodeActions'

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

/** Undo one hunk after a confirm: busy while it runs, then the result (or the failure with Retry). */
function UndoHunk({ ask, undo }: { ask: () => boolean; undo: () => Promise<void> }) {
  const act = useAction(undo, { label: 'Undo change', success: () => 'Undone', failure: errorCause })
  const click = (): void => { if (ask()) void act.run() }
  return (
    <>
      <IconTooltip label="Undo this change in the working tree">
        <VscodeButton secondary disabled={act.busy} aria-busy={act.busy ? 'true' : 'false'} onClick={click}>{act.busy ? 'Undoing…' : 'Undo'}</VscodeButton>
      </IconTooltip>
      <ActionResult action={act} />
    </>
  )
}

function DiffNode({ id, data, selected, height }: NodeProps) {
  const rf = useReactFlow()
  const d = data as { cwd?: string; color?: string; name?: string; title?: string; collapsed?: boolean; comments?: Comment[] }
  const swatch = d.color ?? '#0a84ff'
  const collapsed = d.collapsed ?? false
  const comments = d.comments ?? []
  const toggleCollapse = useNodeCollapse(id, height, collapsed)
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

  /** One page of the changed files; throws on failure. */
  const fetchPage = useCallback(async (offset: number) => {
    if (!root) return
    const page = await fetchDiffList(root, offset)
    setFiles((prev) => (offset === 0 ? page.files : [...prev, ...page.files]))
    setNextOffset(page.nextOffset)
    setTotal(page.total)
    setMsg('')
  }, [root])
  const loadList = useCallback(async (offset = 0) => {
    try { await fetchPage(offset) } catch (e) { setMsg(errText(e)) }
  }, [fetchPage])

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
  const storedWrap = useStore((s) => (s.nodeLookup.get(id)?.data as { wordWrap?: unknown } | undefined)?.wordWrap)
  const wrap = effectiveWrap(storedWrap, file?.path ?? '')
  const toggleWrap = () => rf.updateNodeData(id, { wordWrap: !wrap })
  useWordWrap(editor.wrapTarget, wrap, toggleWrap)

  const open = (path: string) => { setActive(path); void loadFile(path) }
  const askUndo = (header: string): boolean => !!file && window.confirm(`Undo this change in ${file.path}?\n${header}\nThe working-tree lines go back to HEAD.`)
  const onUndo = async (hunkId: string) => {
    if (!file) return
    await undoHunk(root, file.path, hunkId)
    refresh()
  }
  const loadMore = useAction(() => fetchPage(nextOffset ?? 0), { label: 'Load more changed files', success: () => 'Loaded', failure: errorCause })
  const addNote = () => {
    if (!file || !draft.trim()) return
    if (notes.length >= DIFF_NOTES_MAX) { setMsg(`At most ${DIFF_NOTES_MAX} notes; send some first.`); return }
    setNotes((ns) => [...ns, { id: randomId(), path: file.path, line: editor.line, body: draft.trim().slice(0, DIFF_NOTE_BODY_MAX) }])
    setDraft('')
  }
  const moreClick = (): void => { void loadMore.run() }
  // Through the server outbox: queued while the agent is busy, typed once its turn ends.
  const send = useAction(async () => {
    const batch = notes
    await enqueueNotes(agent!.id, batch)
    const sent = new Set(batch.map((n) => n.id))
    setNotes((ns) => ns.filter((n) => !sent.has(n.id)))
    return batch.length
  }, { label: 'Send to agent', success: (n) => `Queued ${n} note${n === 1 ? '' : 's'} for the agent; it gets them as soon as its prompt is free.`, failure: errorCause })
  // A refusal (no agent wired, no notes) is known before sending: it shows as the node message, nothing runs.
  const onSend = (): void => {
    const refusal = sendRefusal(agent?.id ?? null, notes.length)
    if (refusal || !agent) { setMsg(refusal ?? ''); return }
    void send.run()
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
  const wrapKey = wrapChordLabel(useWrapChord())
  // Tab mode: the tab is the header, so the header's actions move to the tab strip and tab menu.
  const nodeHost = useNodeHost()
  const tabActions: TabAction[] = [
    ...(sides ? [{ id: 'wrap', label: 'Word wrap', tooltip: wrapKey ? `Toggle word wrap (${wrapKey})` : 'Toggle word wrap', icon: 'word-wrap', checked: wrap, onSelect: toggleWrap }] : []),
    { id: 'send', label: send.busy ? 'Sending…' : `Send to agent (${notes.length})`, tooltip: sendTip, disabled: send.busy, busy: send.busy, onSelect: onSend },
    { id: 'refresh', label: 'Refresh', tooltip: 'Reload the changed files and the open diff', icon: 'refresh', onSelect: refresh },
  ]

  return (
    <>
      <NodeLayoutResizer collapsed={collapsed} minWidth={420} minHeight={260} color={swatch} />
      <div className={`${termNodeClass({ selected: !!selected, collapsed })} diff-node`} style={{ '--node-swatch': swatch } as CSSProperties}>
        {nodeHost.inTab ? <TabNodeActions id={id} visible={nodeHost.visible} items={[]} actions={tabActions} /> : (
        <NodeChrome
          title={d.title || 'Changes'} name={d.name} icon="git-compare" titleHint={root || undefined}
          description={root ? `${total} file${total === 1 ? '' : 's'}` : undefined}
          onRename={(t) => rf.updateNodeData(id, { title: t })}
          collapsed={collapsed} onToggleCollapse={toggleCollapse}
          color={swatch} onColor={(c) => rf.updateNodeData(id, { color: c })}
          comments={comments} onAddComment={(text) => rf.updateNodeData(id, { comments: [...comments, { id: randomId(), text, ts: Date.now() }] })}
          extraHeader={
            <ToolbarContainer className="nodrag diff-node__actions node-header-actions">
              {sides && <WordWrapButton on={wrap} onToggle={toggleWrap} />}
              <IconTooltip label={sendTip}>
                <VscodeButton secondary disabled={send.busy} aria-busy={send.busy ? 'true' : 'false'} onClick={onSend}>
                  {send.busy ? 'Sending…' : `Send to agent (${notes.length})`}
                </VscodeButton>
              </IconTooltip>
              <IconTooltip label="Reload the changed files and the open diff">
                <ToolbarButton label="Refresh" data-title="Refresh" onClick={refresh}><span className="codicon codicon-refresh" aria-hidden="true" /></ToolbarButton>
              </IconTooltip>
            </ToolbarContainer>
          }
          closeLabel="Close" onClose={() => void rf.deleteElements({ nodes: [{ id }] })}
        />
        )}
        {msg && <div className="diff-node__msg nodrag" role="status">{msg}</div>}
        {send.result && <div className="diff-node__msg nodrag"><ActionResult action={send} /></div>}
        {root && <Suspense fallback={null}><ScmPanel root={root} agentId={agent?.id ?? null} onChanged={refresh} /></Suspense>}
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
                {nextOffset !== null && <li><VscodeButton secondary disabled={loadMore.busy} aria-busy={loadMore.busy ? 'true' : 'false'} onClick={moreClick}>{loadMore.busy ? 'Loading…' : 'Load more'}</VscodeButton></li>}
                {loadMore.result && <li><ActionResult action={loadMore} /></li>}
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
                        {file?.undoable && <UndoHunk ask={() => askUndo(h.header)} undo={() => onUndo(h.id)} />}
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
