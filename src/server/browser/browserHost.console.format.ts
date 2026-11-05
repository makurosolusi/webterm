// CDP console events -> console entry fields, formatted from the event payload alone (RemoteObject value,
// description and preview). Never calls back into the page to stringify: a page getter must not run because
// someone opened the console. Imitates how DevTools renders messages, simplified to one line of text.
import { CONSOLE_STACK_MAX, CONSOLE_TEXT_MAX } from '../../shared/browser.console'
import type { ConsoleEntry, ConsoleFrame, ConsoleLevel, ConsoleSource } from '../../shared/browser.console'

/** Entry minus the fields the buffer assigns (`seq`, `ts`). */
export type EntryBody = Omit<ConsoleEntry, 'seq' | 'ts'>

interface PropPreview { name: string; type: string; value?: string; subtype?: string; valuePreview?: ObjPreview }
interface ObjPreview { type: string; subtype?: string; description?: string; overflow?: boolean; properties?: PropPreview[]; entries?: unknown[] }
export interface RemoteObj {
  type: string; subtype?: string; className?: string; value?: unknown; unserializableValue?: string
  description?: string; preview?: ObjPreview
}
interface CallFrame { functionName?: string; url?: string; lineNumber?: number; columnNumber?: number }
interface StackTrace { callFrames?: CallFrame[] }

export const clipText = (s: string): string => (s.length > CONSOLE_TEXT_MAX ? `${s.slice(0, CONSOLE_TEXT_MAX)}…` : s)

/** Top frames, 1-based positions; empty when absent. */
export function framesOf(st: StackTrace | undefined): ConsoleFrame[] {
  return (st?.callFrames ?? []).slice(0, CONSOLE_STACK_MAX).map((f) => ({
    fn: f.functionName || '(anonymous)', url: f.url ?? '', line: (f.lineNumber ?? 0) + 1, col: (f.columnNumber ?? 0) + 1,
  }))
}

const where = (frames: ConsoleFrame[], url?: string, line?: number, col?: number): Pick<EntryBody, 'url' | 'line' | 'col'> => {
  const f = frames.find((x) => x.url)
  if (f) return { url: f.url, line: f.line, col: f.col }
  return url ? { url, ...(line !== undefined ? { line: line + 1 } : {}), ...(col !== undefined ? { col: col + 1 } : {}) } : {}
}

function previewText(p: ObjPreview): string {
  const props = (p.properties ?? []).map((x) => {
    const v = x.valuePreview ? previewText(x.valuePreview) : x.type === 'string' ? `'${x.value ?? ''}'` : (x.value ?? x.type)
    return p.subtype === 'array' ? v : `${x.name}: ${v}`
  })
  const more = p.overflow ? ', …' : ''
  if (p.subtype === 'array') return `${p.description ?? ''} [${props.join(', ')}${more}]`.trim()
  const head = p.description && p.description !== 'Object' ? `${p.description} ` : ''
  return `${head}{${props.join(', ')}${more}}`
}

/** One RemoteObject as DevTools prints it in a message; `top` strings print raw, nested ones quoted. */
export function formatRemote(o: RemoteObj, top = true): string {
  switch (o.type) {
    case 'string': return top ? String(o.value ?? '') : `'${String(o.value ?? '')}'`
    case 'undefined': return 'undefined'
    case 'number': case 'boolean': case 'bigint':
      return o.unserializableValue ?? o.description ?? String(o.value)
    case 'object':
      if (o.subtype === 'null') return 'null'
      if (o.subtype === 'error') return o.description ?? 'Error'
      if (o.preview && o.subtype !== 'node' && o.subtype !== 'regexp' && o.subtype !== 'date') return previewText(o.preview)
      return o.description ?? o.className ?? 'Object'
    default: return o.description ?? o.type // function, symbol
  }
}

/** `console.log('%s is %d', a, b)`: apply format specifiers of a leading string like DevTools does; `%c` styles are dropped. */
export function formatArgs(args: RemoteObj[]): string {
  if (!args.length) return ''
  const [first, ...rest] = args
  if (first.type !== 'string' || !String(first.value ?? '').includes('%')) return args.map((a) => formatRemote(a)).join(' ')
  let i = 0
  const head = String(first.value).replace(/%([sdifoOc%])/g, (m, k: string) => {
    if (k === '%') return '%'
    if (i >= rest.length) return m
    const a = rest[i++]
    if (k === 'c') return ''
    if (k === 'd' || k === 'i') return a.type === 'number' ? String(Math.trunc(Number(a.value))) : 'NaN'
    if (k === 'f') return a.type === 'number' ? String(a.value) : 'NaN'
    return formatRemote(a, k === 's')
  })
  return [head, ...rest.slice(i).map((a) => formatRemote(a))].join(' ')
}

const API_LEVEL: Record<string, ConsoleLevel> = { debug: 'verbose', error: 'error', assert: 'error', warning: 'warning' }

/** `Runtime.consoleAPICalled` -> entry body; null for calls with nothing to show (`endGroup`) or `clear` (caller clears). */
export function fromConsoleApi(p: Record<string, unknown>): EntryBody | 'clear' | null {
  const type = String(p.type ?? 'log')
  if (type === 'clear') return 'clear'
  if (type === 'endGroup') return null
  const args = Array.isArray(p.args) ? (p.args as RemoteObj[]) : []
  const frames = framesOf(p.stackTrace as StackTrace | undefined)
  let text = formatArgs(args)
  if (type === 'assert') text = `Assertion failed${text ? `: ${text}` : ''}`
  return {
    level: API_LEVEL[type] ?? 'info', source: 'console', text: clipText(text), ...where(frames),
    ...(type === 'trace' || type === 'error' || type === 'assert' ? { stack: frames } : {}),
  }
}

interface ExceptionDetails { text?: string; exception?: RemoteObj; url?: string; lineNumber?: number; columnNumber?: number; stackTrace?: StackTrace }

/** Exception details (`Runtime.exceptionThrown` or a failed eval) -> "Uncaught TypeError: …" with its stack frames. */
export function fromException(d: ExceptionDetails, source: ConsoleSource = 'exception'): EntryBody {
  const desc = d.exception ? formatRemote(d.exception, true) : ''
  const firstLine = desc.split('\n')[0]
  const prefix = d.text ?? 'Uncaught'
  const text = firstLine ? (prefix.endsWith(firstLine) ? prefix : `${prefix} ${firstLine}`) : prefix
  const frames = framesOf(d.stackTrace)
  return { level: 'error', source, text: clipText(text), ...where(frames, d.url, d.lineNumber, d.columnNumber), ...(frames.length ? { stack: frames } : {}) }
}

const LOG_SOURCE: Record<string, ConsoleSource> = { network: 'network', security: 'security' }

/** `Log.entryAdded` (network errors, CSP/security, interventions) -> entry body. */
export function fromLogEntry(p: Record<string, unknown>): EntryBody | null {
  const e = p.entry as { source?: string; level?: string; text?: string; url?: string; lineNumber?: number; stackTrace?: StackTrace } | undefined
  if (!e?.text) return null
  const level = (['verbose', 'info', 'warning', 'error'] as const).find((l) => l === e.level) ?? 'info'
  const frames = framesOf(e.stackTrace)
  return { level, source: LOG_SOURCE[e.source ?? ''] ?? 'browser', text: clipText(e.text), ...where(frames, e.url, e.lineNumber) }
}
