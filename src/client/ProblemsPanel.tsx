// Problems panel (VS Code Problems view, G9 step 1): the workspace's own `tsc --watch` + eslint
// diagnostics from src/server/problems/, a status-bar counter that toggles the panel, rows that
// open the file at the line in an Editor node, and "Fix with agent" that queues the list for an
// agent node of this board through the outbox. Live language-server diagnostics of open editor
// nodes (editorLsp.store.ts) join the list and the counter, deduped against the run's rows.
import { useCallback, useEffect, useMemo, useState, type MutableRefObject } from 'react'
import { createPortal } from 'react-dom'
import type { Node, XYPosition } from '@xyflow/react'
import type { VscodeStatusItem } from '@/components/vscode/vscodeStatusBar'
import type { Problem } from '../server/problems/problems.parse'
import type { ProblemsState } from '../server/problems/problems.service'
import type { Workspace, WsNode } from '../shared/workspace'
import { tokenQuery } from './api'
import { IconTooltip } from '@/components/ui/icon-button'
import { codicon } from './dockCodicon'
import { useLspProblems, type LspProblem } from './editorLsp.store'
import { openEditorAt } from './Omnibox.open'

export const PROBLEMS_POLL_MS = 3000

type Reply = ProblemsState & { total: number }

async function call<T>(op: string, path: string, body?: unknown): Promise<T> {
  const url = `${path}${path.includes('?') ? '&' : '?'}${tokenQuery()}`.replace(/[?&]$/, '')
  const res = await fetch(url, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const out = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) throw new Error(`${op}: ${String(out.message ?? out.error ?? `HTTP ${res.status}`)}`)
  return out as T
}

export const fetchProblems = (ws: string) => call<Reply>('Load problems', `/api/problems?workspace=${encodeURIComponent(ws)}`)
export const runProblems = (ws: string) => call<Reply>('Run problem checks', '/api/problems/run', { workspace: ws })
export const stopProblems = (ws: string) => call<Reply>('Stop problem checks', '/api/problems/stop', { workspace: ws })
export const fixWithAgent = (ws: string, to: string) => call<unknown>('Send problems to agent', '/api/problems/fix', { workspace: ws, to })

/** `src/a.ts:12:5` relative to the workspace folder. */
export function problemLocation(p: Pick<Problem, 'file' | 'line' | 'column'>, root?: string): string {
  const rel = root && p.file.startsWith(`${root.replace(/\/+$/, '')}/`) ? p.file.slice(root.replace(/\/+$/, '').length + 1) : p.file
  return `${rel}:${p.line}:${p.column}`
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`
const problemKey = (p: LspProblem) => `${p.file}:${p.line}:${p.column}:${p.message}`

/** The run's problems, then live language-server ones it does not already list. */
export function mergeProblems(run: Problem[], lsp: LspProblem[]): LspProblem[] {
  const seen = new Set(run.map(problemKey))
  return [...run, ...lsp.filter((p) => !seen.has(problemKey(p)))]
}

/** Agent nodes on the board, the targets "Fix with agent" offers. */
export function agentTargets(nodes: Node[]): Array<{ id: string; label: string }> {
  return nodes.filter((n) => n.type === 'agent').map((n) => ({ id: n.id, label: String((n.data as { title?: string })?.title || n.id) }))
}

/** Problems state + the status bar item for the active workspace. */
export function useProblems(workspaceId: string | null) {
  const [state, setState] = useState<Reply | null>(null)
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const refresh = useCallback(() => {
    if (!workspaceId) return
    fetchProblems(workspaceId).then(setState, (e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [workspaceId])
  useEffect(() => { setState(null); refresh() }, [refresh])
  useEffect(() => {
    if (!workspaceId || (!open && !state?.running)) return
    const t = setInterval(refresh, PROBLEMS_POLL_MS)
    return () => clearInterval(t)
  }, [workspaceId, open, state?.running, refresh])
  const act = useCallback((f: () => Promise<unknown>) => {
    setError(null)
    f().then(refresh, (e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [refresh])
  const lsp = useLspProblems()
  const list = useMemo(() => mergeProblems(state?.problems ?? [], lsp), [state?.problems, lsp])
  const extra = list.slice(state?.problems.length ?? 0)
  const errors = (state?.errors ?? 0) + extra.filter((p) => p.severity === 'error').length
  const warnings = (state?.warnings ?? 0) + extra.filter((p) => p.severity === 'warning').length
  const statusItems = useMemo<VscodeStatusItem[]>(() => (workspaceId ? [{
    id: 'problems', label: `${errors} / ${warnings}`, icon: codicon('issues'), tone: errors > 0 ? 'error' : 'default',
    tooltip: `${plural(errors, 'error')}, ${plural(warnings, 'warning')} from the type checker and linter — toggle Problems`,
    ariaLabel: `Problems: ${errors} errors, ${warnings} warnings`,
    onClick: () => setOpen((v) => !v),
  }] : []), [workspaceId, errors, warnings])
  return { workspaceId, state, list, open, setOpen, error, act, statusItems }
}

export interface ProblemsPanelProps {
  problems: ReturnType<typeof useProblems>
  root?: string
  nodes: Node[]
  nodesRef: MutableRefObject<Node[]>
  addFlowNode: (make: (n: number, ws: Workspace) => Omit<WsNode, 'x' | 'y'>, at?: XYPosition) => void
  onFocus: (id: string) => void
  /** Toolbar slot of the shared bottom panel while this tab is active; null while hidden. */
  actionsHost: HTMLElement | null
}

/** Pane body of the Problems tab; `bottomPanelHost` owns the surface and the open state. */
export default function ProblemsPanel({ problems: pr, root, nodes, nodesRef, addFlowNode, onFocus, actionsHost }: ProblemsPanelProps) {
  const agents = useMemo(() => agentTargets(nodes), [nodes])
  const [target, setTarget] = useState('')
  const to = agents.some((a) => a.id === target) ? target : agents[0]?.id ?? ''
  const ws = pr.workspaceId
  if (!ws) return null
  const s = pr.state
  const list = pr.list

  const openAt = (p: LspProblem) => openEditorAt({ nodesRef, addFlowNode, onFocus }, p.file, p.line, p.column)

  const actions = (
    <>
      {s?.running
        ? (
          <IconTooltip label="Watching for problems. Click to stop watching">
            <button type="button" className="vscode-panel-action" aria-label="Stop watching" onClick={() => pr.act(() => stopProblems(ws))}>{codicon('debug-stop')}</button>
          </IconTooltip>
        )
        : (
          <IconTooltip label="Not watching. Click to run TypeScript and ESLint checks">
            <button type="button" className="vscode-panel-action" aria-label="Run checks" onClick={() => pr.act(() => runProblems(ws))}>{codicon('play')}</button>
          </IconTooltip>
        )}
      {agents.length > 1 && (
        <select aria-label="Agent to fix with" value={to} onChange={(e) => setTarget(e.target.value)}>
          {agents.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
        </select>
      )}
      <IconTooltip label="Fix with agent" disabled={!to || !s?.problems.length}
        disabledReason={!to ? 'add an agent node to fix with' : 'no problems to fix'}>
        <button type="button" className="vscode-panel-action" disabled={!to || !s?.problems.length} aria-label="Fix with agent"
          onClick={() => pr.act(() => fixWithAgent(ws, to))}>{codicon('sparkle')}</button>
      </IconTooltip>
    </>
  )

  const empty = s?.ran ? 'No problems have been detected in the workspace.' : 'Press Run to check this workspace with its TypeScript compiler and ESLint.'

  return (
    <div className="problems-panel">
      {actionsHost && createPortal(actions, actionsHost)}
      {(pr.error || s?.error) && <div role="alert" className="inbox-item">{pr.error ?? s?.error}</div>}
      {s?.ran && s.tools.length === 0 && <div className="inbox-item">No TypeScript compiler or ESLint is installed in this workspace (node_modules/.bin).</div>}
      {list.length === 0
        ? <div className="inbox-item">{empty}</div>
        : (
          <ul role="list" aria-label="Problems list" style={{ listStyle: 'none', margin: 0, padding: 0, overflow: 'auto' }}>
            {list.map((p, i) => (
              <li key={`${p.file}:${p.line}:${p.column}:${i}`}>
                <IconTooltip label={`Open ${problemLocation(p, root)}`}>
                  <button type="button" className="inbox-item" style={{ width: '100%', textAlign: 'left' }} onClick={() => openAt(p)}>
                    {codicon(p.severity === 'error' ? 'error' : 'warning')} {p.message}{' '}
                    <span style={{ opacity: 0.7 }}>{p.source}{p.code ? `(${p.code})` : ''} {problemLocation(p, root)}</span>
                  </button>
                </IconTooltip>
              </li>
            ))}
          </ul>
        )}
    </div>
  )
}
