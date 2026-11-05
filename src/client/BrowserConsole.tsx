// Console drawer of a browser node (imitates Chrome DevTools Console): level filter (Verbose hidden by default),
// text filter, Clear, Preserve log, and a prompt that evaluates in the page. Entries arrive as deltas over the
// browser WS (`useBrowserSession`); the server owns the buffer, so Clear/Preserve are server commands.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode, RefObject } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { IconButton } from '@/components/ui/icon-button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { sourceLabel } from '../shared/browser.console'
import type { ConsoleClientMsg, ConsoleEntry, ConsoleView } from '../shared/browser.console'
import type { Lease } from '../shared/browser.contract'
import { eventChord } from './commandRegistry'
import { isMacPlatform } from './terminalKeys'

/** Command id + chord of the toggle (Chrome's ⌥⌘J), listed in the Keyboard Shortcuts overlay as a fixed command. */
export const CONSOLE_COMMAND_ID = 'browser.toggleConsole'
export const CONSOLE_CHORD = 'Mod+Alt+J'
/** Rows rendered at most (newest kept); the buffer itself holds up to CONSOLE_BUFFER_MAX. */
export const CONSOLE_RENDER_MAX = 200

export const CONSOLE_TEXT = {
  toggle: 'Console',
  toggleHintOff: 'Show the page console',
  toggleHintOn: 'Hide the page console',
  errors: (n: number) => `${n} error${n === 1 ? '' : 's'}`,
  region: 'Page console',
  levels: 'Message levels',
  all: 'All', error: 'Errors', warning: 'Warnings', info: 'Info', verbose: 'Verbose',
  filter: 'Filter',
  clear: 'Clear console',
  preserve: 'Preserve log',
  prompt: 'Evaluate JavaScript in the page',
  promptHint: 'Type an expression and press Enter',
  agentDriving: 'An agent is driving this browser; take over to use the console',
  dropped: (n: number) => `${n} older message${n === 1 ? '' : 's'} dropped`,
  capped: (shown: number, total: number) => `Showing the newest ${shown} of ${total} matching messages`,
  empty: 'No messages',
  captureStarted: 'Capturing from now on. Reload the page to see messages from page load.',
  reload: 'Reload',
} as const

type LevelFilter = 'all' | 'error' | 'warning' | 'info'
const FILTERS: LevelFilter[] = ['all', 'error', 'warning', 'info']
type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never
type Send = (msg: WithoutId<ConsoleClientMsg>) => void

/** Entries the filters let through (Chrome: Verbose is off by default, text matches message or source). */
export function filterEntries(entries: ConsoleEntry[], level: LevelFilter, verbose: boolean, text: string): ConsoleEntry[] {
  const q = text.trim().toLowerCase()
  return entries.filter((e) => {
    if (e.level === 'verbose' ? !verbose || level !== 'all' : level !== 'all' && e.level !== level) return false
    return !q || e.text.toLowerCase().includes(q) || sourceLabel(e.url, e.line).toLowerCase().includes(q)
  })
}

export const errorCount = (v: ConsoleView): number => v.entries.reduce((n, e) => n + (e.level === 'error' ? 1 : 0), 0)

const ICON: Record<ConsoleEntry['level'], string> = { error: 'error', warning: 'warning', info: '', verbose: '' }
const PREFIX: Partial<Record<ConsoleEntry['source'], string>> = { command: '> ', result: '< ' }

function Row({ e }: { e: ConsoleEntry }) {
  const src = sourceLabel(e.url, e.line)
  return (
    <div role="listitem" className={`browser-console__row is-${e.level} src-${e.source}`} data-level={e.level}>
      <span className={`codicon codicon-${ICON[e.level] || 'blank'}`} aria-hidden="true" />
      <div className="browser-console__msg">
        <span className="browser-console__text">{PREFIX[e.source] ?? ''}{e.text}</span>
        {e.stack?.map((f, i) => <div key={i} className="browser-console__frame">{`at ${f.fn} (${sourceLabel(f.url, f.line)}:${f.col})`}</div>)}
      </div>
      {src && <span className="browser-console__src">{src}</span>}
    </div>
  )
}

export interface BrowserConsoleProps {
  view: ConsoleView; send: Send; lease?: Lease
  /** Capture was switched on by opening the drawer: offer a reload to catch messages from page load. */
  hint?: boolean
  onReload?: () => void
}

/** The drawer itself (rendered only while open). */
export default function BrowserConsole({ view, send, lease, hint, onReload }: BrowserConsoleProps) {
  const [level, setLevel] = useState<LevelFilter>('all')
  const [verbose, setVerbose] = useState(false)
  const [text, setText] = useState('')
  const [expr, setExpr] = useState('')
  const list = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const shown = filterEntries(view.entries, level, verbose, text)
  const rows = shown.slice(-CONSOLE_RENDER_MAX)
  const agent = lease === 'agent'

  // Follow new messages while scrolled to the bottom (Chrome behaviour); scrolling up stops following.
  useLayoutEffect(() => { const el = list.current; if (el && stick.current) el.scrollTop = el.scrollHeight })
  const onScroll = () => { const el = list.current; if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8 }

  const onPrompt = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation() // keys typed here belong to the prompt, not the canvas or the page
    if (e.key !== 'Enter' || e.shiftKey || !expr.trim()) return
    e.preventDefault()
    send({ t: 'console', op: 'eval', expr })
    setExpr('')
    stick.current = true
  }

  return (
    <section aria-label={CONSOLE_TEXT.region} className="browser-console nodrag nowheel">
      <div className="browser-console__bar">
        <IconButton size="icon-xs" label={CONSOLE_TEXT.clear} onClick={() => send({ t: 'console', op: 'clear' })}><span className="codicon codicon-clear-all" aria-hidden="true" /></IconButton>
        <Input className="h-5 w-32 text-xs" aria-label={CONSOLE_TEXT.filter} placeholder={CONSOLE_TEXT.filter} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
        <div role="group" aria-label={CONSOLE_TEXT.levels} className="flex items-center gap-0.5">
          {FILTERS.map((f) => (
            <Button key={f} size="xs" variant={level === f ? 'secondary' : 'ghost'} aria-pressed={level === f} onClick={() => setLevel(f)}>{CONSOLE_TEXT[f]}</Button>
          ))}
        </div>
        <Label className="text-xs"><Checkbox checked={verbose} onCheckedChange={(c) => setVerbose(c === true)} />{CONSOLE_TEXT.verbose}</Label>
        <Label className="text-xs"><Checkbox checked={view.preserve} onCheckedChange={(c) => send({ t: 'console', op: 'preserve', on: c === true })} />{CONSOLE_TEXT.preserve}</Label>
      </div>
      {hint && (
        <div role="status" className="browser-console__hint">
          <span>{CONSOLE_TEXT.captureStarted}</span>
          {onReload && <Button size="xs" variant="ghost" onClick={onReload}>{CONSOLE_TEXT.reload}</Button>}
        </div>
      )}
      <div ref={list} role="list" className="browser-console__list" onScroll={onScroll}>
        {view.dropped > 0 && <div className="browser-console__note">{CONSOLE_TEXT.dropped(view.dropped)}</div>}
        {shown.length > rows.length && <div className="browser-console__note">{CONSOLE_TEXT.capped(rows.length, shown.length)}</div>}
        {rows.length === 0 && <div className="browser-console__note">{CONSOLE_TEXT.empty}</div>}
        {rows.map((e) => <Row key={e.seq} e={e} />)}
      </div>
      <div className="browser-console__prompt">
        <span className="codicon codicon-chevron-right" aria-hidden="true" />
        <Input
          className="h-5 flex-1 font-mono text-xs" spellCheck={false} autoComplete="off"
          aria-label={CONSOLE_TEXT.prompt} placeholder={agent ? CONSOLE_TEXT.agentDriving : CONSOLE_TEXT.promptHint}
          disabled={agent} value={expr} onChange={(e) => setExpr(e.target.value)} onKeyDown={onPrompt}
        />
      </div>
    </section>
  )
}

/** Toolbar toggle; the error badge shows while the drawer is closed. */
export function BrowserConsoleToggle({ open, errors, toggle }: ConsoleSlot) {
  return (
    <IconButton
      size="xs" variant={open ? 'secondary' : 'ghost'} aria-pressed={open} label={CONSOLE_TEXT.toggle} commandId={CONSOLE_COMMAND_ID}
      tooltip={open ? CONSOLE_TEXT.toggleHintOn : CONSOLE_TEXT.toggleHintOff} onClick={toggle}
    >
      <span className="codicon codicon-debug-console" aria-hidden="true" />
      {!open && errors > 0 && <Badge variant="destructive" aria-label={CONSOLE_TEXT.errors(errors)}>{errors}</Badge>}
    </IconButton>
  )
}

export interface ConsoleSlot { open: boolean; errors: number; toggle: () => void }

/**
 * Drawer state of one node + the ⌥⌘J shortcut while focus is inside this node (capture phase, so the key is
 * not forwarded to the page). Opening the drawer asks the server to start capture (Runtime is enabled lazily) and
 * shows the reload hint when capture was off until then. Returns the toolbar slot and the drawer element.
 */
export function useConsoleDrawer(hostRef: RefObject<HTMLElement | null>, view: ConsoleView, send: Send, lease?: Lease, reload?: () => void): { slot: ConsoleSlot; drawer: ReactNode } {
  const [open, setOpen] = useState(false)
  const [hint, setHint] = useState(false)
  const toggle = useCallback(() => setOpen((o) => !o), [])
  const sendRef = useRef(send)
  sendRef.current = send
  // Also re-asks when the server reports capture off while open (e.g. server restarted).
  useEffect(() => {
    if (!open) { setHint(false); return }
    if (view.capturing) return
    setHint(true)
    sendRef.current({ t: 'console', op: 'open' })
  }, [open, view.capturing])
  const onReload = reload && (() => { setHint(false); reload() })
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const node = hostRef.current?.closest('.browser-node')
      if (!node?.contains(document.activeElement) || eventChord(e, isMacPlatform()) !== CONSOLE_CHORD) return
      e.preventDefault()
      e.stopPropagation()
      toggle()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [hostRef, toggle])
  return { slot: { open, errors: errorCount(view), toggle }, drawer: open ? <BrowserConsole view={view} send={send} lease={lease} hint={hint} onReload={onReload} /> : null }
}
