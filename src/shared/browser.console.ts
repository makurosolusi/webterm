// Console panel of a browser node (imitates Chrome DevTools Console): entry types, wire messages and the
// pure helpers both sides share. Server captures Runtime/Log events into a per-node ring buffer and streams
// batched deltas; the client merges them. Pure: no client/server imports, no side effects.
import { TEXT_MAX_BYTES } from './browser.contract'

/** Entries kept per node (server ring buffer and client list); older ones are dropped and counted. */
export const CONSOLE_BUFFER_MAX = 500
/** Bursts are batched: at most one delta per node per this interval, so a page spamming console.log can't flood the WS. */
export const CONSOLE_FLUSH_MS = 100
/** Newest entries sent per delta; older ones of a burst are not streamed (still in the buffer for reattach and agent reads). */
export const CONSOLE_BATCH_MAX = 100
/** Characters kept per entry text (Chrome also elides huge messages). */
export const CONSOLE_TEXT_MAX = 4000
/** Stack frames kept per entry. */
export const CONSOLE_STACK_MAX = 10
/** Eval input limit, same as typed text. */
export const CONSOLE_EVAL_MAX_BYTES = TEXT_MAX_BYTES

/** Chrome's message levels, lowest first. */
export const CONSOLE_LEVELS = ['verbose', 'info', 'warning', 'error'] as const
export type ConsoleLevel = (typeof CONSOLE_LEVELS)[number]
/** Where an entry came from: page console API, uncaught exception, browser log (network/CSP/security), the prompt. */
export type ConsoleSource = 'console' | 'exception' | 'network' | 'security' | 'browser' | 'command' | 'result' | 'system'

/** One stack frame; line/col 1-based like DevTools shows them. */
export interface ConsoleFrame { fn: string; url: string; line: number; col: number }

export interface ConsoleEntry {
  /** Monotonic per node; never reused, so the client can key rows by it. */
  seq: number
  ts: number
  level: ConsoleLevel
  source: ConsoleSource
  text: string
  url?: string
  line?: number
  col?: number
  stack?: ConsoleFrame[]
}

/** Delta for one node: append `entries` (or replace the list when `reset`); `dropped` = total dropped so far. */
/** `capturing` = Runtime (console calls, exceptions) is on for the node; off until its console is first used. */
export interface ConsoleDelta { id: string; entries: ConsoleEntry[]; dropped: number; preserve: boolean; capturing: boolean; reset?: true }

export type ConsoleClientMsg =
  | { t: 'console'; id: string; op: 'open' }
  | { t: 'console'; id: string; op: 'eval'; expr: string }
  | { t: 'console'; id: string; op: 'clear' }
  | { t: 'console'; id: string; op: 'preserve'; on: boolean }
export type ConsoleServerMsg = { t: 'console' } & ConsoleDelta

/** Validate a `console` client message (already known to be an object with a valid `id`); null = reject. */
export function parseConsoleMsg(m: Record<string, unknown>, id: string): ConsoleClientMsg | null {
  switch (m.op) {
    case 'open': return { t: 'console', id, op: 'open' }
    case 'clear': return { t: 'console', id, op: 'clear' }
    case 'preserve': return typeof m.on === 'boolean' ? { t: 'console', id, op: 'preserve', on: m.on } : null
    case 'eval':
      return typeof m.expr === 'string' && m.expr.trim() !== '' && new TextEncoder().encode(m.expr).length <= CONSOLE_EVAL_MAX_BYTES
        ? { t: 'console', id, op: 'eval', expr: m.expr } : null
    default: return null
  }
}

/** Client view of one node's console. */
export interface ConsoleView { entries: ConsoleEntry[]; dropped: number; preserve: boolean; capturing: boolean }
export const EMPTY_CONSOLE: ConsoleView = { entries: [], dropped: 0, preserve: false, capturing: false }

/** Merge a delta into the view, keeping at most `CONSOLE_BUFFER_MAX` newest entries. */
export function applyConsoleDelta(v: ConsoleView, d: ConsoleDelta): ConsoleView {
  const last = d.reset ? 0 : (v.entries[v.entries.length - 1]?.seq ?? 0)
  const merged = d.reset ? d.entries : v.entries.concat(d.entries.filter((e) => e.seq > last)) // a delta may repeat entries the attach snapshot already had
  return { entries: merged.length > CONSOLE_BUFFER_MAX ? merged.slice(-CONSOLE_BUFFER_MAX) : merged, dropped: d.dropped, preserve: d.preserve, capturing: d.capturing }
}

/** True when `level` is at or above `min` (agent `console` verb filter). */
export const atLeast = (level: ConsoleLevel, min: ConsoleLevel): boolean => CONSOLE_LEVELS.indexOf(level) >= CONSOLE_LEVELS.indexOf(min)

/** "file.js:12" like DevTools' source link: last path segment of the URL, query/hash dropped. */
export function sourceLabel(url: string | undefined, line?: number): string {
  if (!url) return ''
  const name = url.replace(/[?#].*$/, '').split('/').filter(Boolean).pop() ?? url
  return line ? `${name}:${line}` : name
}
