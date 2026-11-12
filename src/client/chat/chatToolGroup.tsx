// Tool activity in the Central thread: a run of consecutive tool calls collapses into one native
// `<details>` row ("Used 3 tools · 1 failed"), as in Claude.ai / ChatGPT / Cursor. The cards inside
// are unchanged. Approval parts are never grouped: they need the user, so they stay visible.
import type { ChatMessage, ChatPart } from './chatTypes'

export type ToolPart = Extract<ChatPart, { type: 'tool' }>
/** What a message renders: a plain part, or a run of tool parts shown as one group. */
export type Segment = { kind: 'part'; part: ChatPart } | { kind: 'tools'; tools: ToolPart[] }
/** One rendered row: the message (header, state) and its segments, possibly with later tool-only messages folded in. */
export interface ThreadRow { message: ChatMessage; segments: Segment[] }

const RUNNING: ReadonlySet<ToolPart['state']> = new Set(['requested', 'running'])

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function summarize(value: unknown): string {
  if (value === undefined) return ''
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    return clip(text, 240)
  } catch {
    return '[unreadable]'
  }
}

export function ToolCard(props: { part: ToolPart }) {
  const { part } = props
  const summary = summarize(part.result ?? part.args)
  return (
    <div className="chat-tool" data-state={part.state}>
      <span className="chat-tool__icon codicon codicon-tools" aria-hidden="true" />
      <span className="chat-tool__name">{part.name}</span>
      <span className={`chat-tool__state chat-tool__state--${part.state}`}>{part.state.replace('_', ' ')}</span>
      {summary !== '' && (
        <details className="chat-tool__detail">
          <summary>{part.result !== undefined ? 'result' : 'arguments'}</summary>
          <pre>{summary}</pre>
        </details>
      )}
    </div>
  )
}

/** A collapsed run of tool calls. Uncontrolled `<details>`: its open state lives as long as the row does (session only). */
export function ToolGroup(props: { tools: ToolPart[] }) {
  const { tools } = props
  const running = [...tools].reverse().find((t) => RUNNING.has(t.state))
  const failed = tools.filter((t) => t.state === 'failed').length
  return (
    <details className="chat-tool-group" data-running={running ? 'true' : undefined}>
      <summary className="chat-tool-group__summary">
        {running ? (
          <>
            <span className="codicon codicon-loading codicon-modifier-spin" aria-hidden="true" />
            <span>{`Running ${running.name}…`}</span>
          </>
        ) : (
          <>
            <span className="codicon codicon-tools" aria-hidden="true" />
            <span>{`Used ${tools.length} ${tools.length === 1 ? 'tool' : 'tools'}`}</span>
          </>
        )}
        {failed > 0 && <span className="chat-tool-group__failed">{` · ${failed} failed`}</span>}
      </summary>
      <div className="chat-tool-group__body">
        {tools.map((tool) => <ToolCard key={tool.toolCallId} part={tool} />)}
      </div>
    </details>
  )
}

/** A message's parts with each run of consecutive tool parts merged into one segment. */
export function segmentParts(parts: readonly ChatPart[]): Segment[] {
  const out: Segment[] = []
  for (const part of parts) {
    const last = out[out.length - 1]
    if (part.type === 'tool' && last?.kind === 'tools') last.tools.push(part)
    else if (part.type === 'tool') out.push({ kind: 'tools', tools: [part] })
    else out.push({ kind: 'part', part })
  }
  return out
}

/** Whether a message holds nothing but tool calls and carries no header of its own worth keeping. */
function toolOnly(message: ChatMessage): boolean {
  return (message.role === 'assistant' || message.role === 'tool') && message.parts.length > 0 &&
    message.parts.every((p) => p.type === 'tool') && !message.usage && message.state !== 'failed'
}

/**
 * Thread rows: a tool-only message right after an assistant/tool row that ends in a tool group
 * joins that group instead of starting its own row, so one run of activity is one summary.
 */
export function threadRows(messages: readonly ChatMessage[]): ThreadRow[] {
  const rows: ThreadRow[] = []
  for (const message of messages) {
    const prev = rows[rows.length - 1]
    const tail = prev?.segments[prev.segments.length - 1]
    if (prev && prev.message.role !== 'human' && prev.message.role !== 'system' && tail?.kind === 'tools' && toolOnly(message)) {
      tail.tools.push(...(message.parts as ToolPart[]))
      continue
    }
    rows.push({ message, segments: segmentParts(message.parts) })
  }
  return rows
}
