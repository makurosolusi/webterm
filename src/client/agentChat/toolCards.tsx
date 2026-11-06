// One card per Claude tool call in the agent chat node (PLAN/AGENT-CHAT.md D11). Layout follows the
// Claude Code VS Code view: a one-line header (state glyph, tool name, summary) over a per-tool body.
// Tool input is untrusted `unknown` from the SDK, so every field is read through the guards below.
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import type { AgentChatToolState } from '../../shared/agentChat.wire'
import type { ToolCardProps, ToolEvent } from './agentChatCards.types'
import './agentChatCards.css'

/** A body longer than this many lines (or chars) starts collapsed. */
const LONG_LINES = 12
const LONG_CHARS = 1_200
const SUMMARY_MAX = 120

export const rec = (v: unknown): Record<string, unknown> =>
  (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
export const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
export const errorText = (e: unknown): string => (e instanceof Error && e.message ? e.message : 'Something went wrong.')

const clip = (s: string): string => (s.length > SUMMARY_MAX ? `${s.slice(0, SUMMARY_MAX)}…` : s)
const json = (v: unknown): string => {
  try { return JSON.stringify(v, null, 2) ?? '' } catch { return '[unreadable input]' }
}
const isTask = (name: string): boolean => name === 'Task' || name === 'Agent'

/** Lines range of a Read call ("lines 10–29"), or '' for a whole-file read. */
export function readRange(input: unknown): string {
  const i = rec(input)
  const offset = num(i.offset)
  const limit = num(i.limit)
  if (offset === undefined && limit === undefined) return ''
  const from = offset ?? 1
  return limit === undefined ? `from line ${from}` : `lines ${from}–${from + limit - 1}`
}

/** One-line summary of a tool call; shared by ToolCard and the permission cards. */
export function toolSummary(name: string, input: unknown): string {
  const i = rec(input)
  switch (name) {
    case 'Bash': return clip(str(i.description) || str(i.command))
    case 'Edit': case 'MultiEdit': case 'Write': case 'NotebookEdit': return str(i.file_path) || str(i.notebook_path)
    case 'Read': return [str(i.file_path), readRange(input)].filter(Boolean).join(' · ')
    case 'Grep': case 'Glob': return clip([str(i.pattern), str(i.path) && `in ${str(i.path)}`].filter(Boolean).join(' '))
    case 'TodoWrite': return `${Array.isArray(i.todos) ? i.todos.length : 0} todos`
    case 'WebFetch': return str(i.url)
    case 'WebSearch': return clip(str(i.query))
    default:
      if (isTask(name)) return clip(str(i.description))
      return clip(json(input).replace(/\s+/g, ' '))
  }
}

export type DiffLine = { k: ' ' | '-' | '+'; t: string }
const split = (s: string): string[] => (s === '' ? [] : s.split('\n'))

/** Line diff of `before` → `after`: shared head/tail lines kept as context, the middle as -/+. */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = split(before)
  const b = split(after)
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++
  const ctx = (t: string): DiffLine => ({ k: ' ', t })
  return [
    ...a.slice(0, head).map(ctx),
    ...a.slice(head, a.length - tail).map((t): DiffLine => ({ k: '-', t })),
    ...b.slice(head, b.length - tail).map((t): DiffLine => ({ k: '+', t })),
    ...a.slice(a.length - tail).map(ctx),
  ]
}

/** -/+ hunks an Edit, MultiEdit or Write call makes, from its input strings. */
export function editDiff(name: string, input: unknown): DiffLine[] {
  const i = rec(input)
  if (name === 'Write') return split(str(i.content)).map((t) => ({ k: '+', t }))
  const edits = name === 'MultiEdit' && Array.isArray(i.edits) ? i.edits.map(rec) : [i]
  return edits.flatMap((e) => diffLines(str(e.old_string), str(e.new_string)))
}

/** Match count of a Grep/Glob result: "Found N …" when the tool says so, else non-empty lines. */
export function matchCount(result: string): number {
  const found = /^Found (\d+)/.exec(result)
  if (found) return Number(found[1])
  return result.split('\n').filter((l) => l.trim() !== '' && !/^No (files|matches) found/.test(l)).length
}

const STATE_LABEL: Record<AgentChatToolState, string> = {
  running: 'Running', awaiting_approval: 'Awaiting approval', done: 'Done', error: 'Error', denied: 'Denied',
}
const STATE_ICON: Record<AgentChatToolState, string> = {
  running: 'loading codicon-modifier-spin', awaiting_approval: 'shield', done: 'check', error: 'error', denied: 'circle-slash',
}

function Diff({ lines }: { lines: DiffLine[] }) {
  if (lines.length === 0) return <div className="acc-muted">No changes.</div>
  return (
    <pre className="acc-diff" aria-label="Diff">
      {lines.map((l, n) => <div key={n} className={`acc-diff__line acc-diff__line--${l.k === '+' ? 'add' : l.k === '-' ? 'del' : 'ctx'}`}>{`${l.k} ${l.t}`}</div>)}
    </pre>
  )
}

function Todos({ input }: { input: unknown }) {
  const todos = Array.isArray(rec(input).todos) ? (rec(input).todos as unknown[]).map(rec) : []
  const glyph = (s: string): string => (s === 'completed' ? 'pass-filled' : s === 'in_progress' ? 'circle-large-filled' : 'circle-large-outline')
  return (
    <ul className="acc-todos" aria-label="Todo list">
      {todos.map((t, n) => (
        <li key={n} className="acc-todos__item" data-status={str(t.status)}>
          <span className={`codicon codicon-${glyph(str(t.status))}`} aria-hidden="true" />
          <span>{str(t.status) === 'in_progress' ? str(t.activeForm) || str(t.content) : str(t.content)}</span>
        </li>
      ))}
    </ul>
  )
}

/** The tool's own input, per tool name; output is rendered separately below it. */
function ToolInput({ tool }: { tool: ToolEvent }) {
  const i = rec(tool.input)
  switch (tool.name) {
    case 'Bash': return <pre className="acc-code acc-code--cmd">{`$ ${str(i.command)}`}</pre>
    case 'Edit': case 'MultiEdit': case 'Write': return <Diff lines={editDiff(tool.name, tool.input)} />
    case 'Read': case 'Grep': case 'Glob': return null
    case 'TodoWrite': return <Todos input={tool.input} />
    default:
      if (isTask(tool.name)) return str(i.subagent_type) ? <div className="acc-muted">{`Subagent: ${str(i.subagent_type)}`}</div> : null
      return <pre className="acc-code">{json(tool.input)}</pre>
  }
}

/** What the header adds after the summary for Grep/Glob ("3 results") once a result is in. */
function countNote(tool: ToolEvent): string {
  if ((tool.name !== 'Grep' && tool.name !== 'Glob') || tool.result === undefined) return ''
  const n = matchCount(tool.result)
  return `${n} ${n === 1 ? 'result' : 'results'}`
}

/** Output of the call; a cut (`truncated`) result offers "Show full output" through `loadFull`. */
function ToolOutput({ tool, loadFull }: Pick<ToolCardProps, 'tool' | 'loadFull'>) {
  const [full, setFull] = useState<string>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const text = full ?? tool.result
  if (text === undefined || text === '' || tool.name === 'TodoWrite') return null
  const fetchFull = async (): Promise<void> => {
    setLoading(true)
    setError(undefined)
    try { setFull(await loadFull(tool.id)) } catch (e) { setError(errorText(e)) } finally { setLoading(false) }
  }
  return (
    <>
      <pre className={`acc-code acc-output${tool.state === 'error' || tool.state === 'denied' ? ' acc-output--error' : ''}`} aria-label="Tool output">{text}</pre>
      {tool.truncated && full === undefined && (
        <div className="acc-row">
          <Button variant="link" size="xs" disabled={loading} onClick={() => void fetchFull()}>
            {loading ? <><span className="codicon codicon-loading codicon-modifier-spin" aria-hidden="true" />Loading full output…</> : error ? 'Retry' : 'Show full output'}
          </Button>
          {error && <span className="acc-error" role="alert">{`Could not load the full output: ${error}`}</span>}
        </div>
      )}
    </>
  )
}

const isLong = (tool: ToolEvent): boolean => {
  const body = `${tool.result ?? ''}${tool.name === 'Write' ? str(rec(tool.input).content) : ''}`
  return body.length > LONG_CHARS || body.split('\n').length > LONG_LINES
}

/** Card of one tool call; Task cards nest their subagent's content as `children`. */
export function ToolCard({ tool, loadFull, children }: ToolCardProps) {
  const [open, setOpen] = useState(() => !isLong(tool))
  const summary = toolSummary(tool.name, tool.input)
  const note = countNote(tool)
  return (
    <div className="acc-card acc-tool" data-state={tool.state} data-tool={tool.name}>
      <Button variant="ghost" className="acc-tool__head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className={`acc-tool__state codicon codicon-${STATE_ICON[tool.state]}`} aria-hidden="true" />
        <span className="acc-tool__name">{isTask(tool.name) ? 'Subagent' : tool.name}</span>
        {summary && <span className="acc-tool__summary">{summary}</span>}
        {note && <span className="acc-muted">{note}</span>}
        <span className={`acc-badge acc-badge--${tool.state}`}>{STATE_LABEL[tool.state]}</span>
      </Button>
      {open && (
        <div className="acc-tool__body">
          <ToolInput tool={tool} />
          {children && <div className="acc-tool__children">{children}</div>}
          <ToolOutput tool={tool} loadFull={loadFull} />
        </div>
      )}
    </div>
  )
}
