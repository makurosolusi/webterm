// The ONE way the server submits a prompt to a node's PTY (outbox, Central, control API, spawn, tasks).
//
// Why: Claude Code's TUI reads text and its Enter arriving in ONE write as a paste, so the `\r` does not
// submit and the prompt sits unsent in the input box (user report: Central "started" work that was
// never submitted). Approach: type the
// text, wait until the screen SHOWS it, then send Enter as a SEPARATE write. webterm reads its rebuilt
// screen (`readClaudeComposer`) instead of a tmux capture, and adds two checks on top: the composer must be empty before typing (a booting Claude has none yet), and the agent must
// visibly START after the Enter (composer empty again, or status `working`), else Enter once more.
//
// A plain shell gets `text\r` in one write (it executes either way); a non-Claude agent has no
// readable composer, so it gets the fixed gap the outbox always used.
import type { AgentId, AgentStatus } from '../shared/workspace'
import { hasClaudeHookSettings } from '../shared/workspace'
import { readClaudeComposer, type ClaudeComposer } from './linkNoteComposer'
import { renderStyledScreen } from './linkNoteScreen'

/** Poll cadence and count for "text on screen" (outbox measurement). */
export const SUBMIT_POLL_MS = 100
export const SUBMIT_POLLS = 20
/** Non-Claude agents have no readable composer: Enter after this fixed gap. */
export const SUBMIT_GAP_MS = 150
/** How long a caller waits for an empty composer by default (a human mid-draft, a dialog). */
export const READY_WAIT_MS = 2_000
/** A freshly spawned Claude draws its composer only after boot; bounded so a trust dialog fails. */
export const SPAWN_READY_WAIT_MS = 30_000
/** Enters tried before giving up on "started": the first can be eaten while the TUI is busy redrawing. */
export const SUBMIT_ENTERS = 2
/** Ctrl-U: kill to line start, the clear-line every agent TUI honours. */
export const KILL_LINE = '\x15'
const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'

/** What the helper needs from a session layer (the real `Sessions` has all four). */
export interface SubmitSessions {
  input(id: string, data: string): void
  statusOf(id: string): AgentStatus | undefined
  screenSource(id: string): { data: string; cols: number; rows: number } | undefined
  /** The agent the session was launched as; undefined = plain shell. */
  agentIdOf(id: string): string | undefined
}

export interface SubmitOptions {
  /** Wait this long for an empty composer before typing (default READY_WAIT_MS). */
  readyMs?: number
  /** Right before the first Enter, once the text is confirmed on screen. */
  beforeEnter?(): void
  render?: (data: string, cols: number, rows: number) => Promise<string>
  sleep?: (ms: number) => Promise<void>
}

export type SubmitFailure = 'not_ready' | 'not_on_screen' | 'not_started'
export type SubmitResult =
  | { ok: true; started: true }
  /** `cleared` (not_on_screen only): the unseen text was removed from the input box again. */
  | { ok: false; reason: SubmitFailure; message: string; cleared?: boolean }

const STARTED: SubmitResult = { ok: true, started: true }
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Is `agentId` a Claude Code agent whose composer the screen reader understands? */
export const isClaudeAgent = (agentId: string | undefined): boolean => !!agentId && hasClaudeHookSettings(agentId as AgentId)

/** Type `text` into `nodeId` and submit it; for Claude, confirmed on screen at every step. */
export async function submitToNode(s: SubmitSessions, nodeId: string, text: string, o: SubmitOptions = {}): Promise<SubmitResult> {
  const sleep = o.sleep ?? wait
  const agent = s.agentIdOf(nodeId)
  if (!agent) { o.beforeEnter?.(); s.input(nodeId, `${text}\r`); return STARTED }
  if (!isClaudeAgent(agent)) {
    s.input(nodeId, text)
    await sleep(SUBMIT_GAP_MS)
    o.beforeEnter?.()
    s.input(nodeId, '\r')
    return STARTED
  }
  const composer = async (): Promise<ClaudeComposer> => {
    const src = s.screenSource(nodeId)
    return src ? readClaudeComposer(await (o.render ?? renderStyledScreen)(src.data, src.cols, src.rows)) : 'unknown'
  }
  /** `ok` within `polls` reads; `first` = read before the first sleep. */
  const until = async (ok: () => Promise<boolean>, polls: number, first = false): Promise<boolean> => {
    for (let i = 0; i < polls; i++) {
      if (i > 0 || !first) await sleep(SUBMIT_POLL_MS)
      if (await ok()) return true
    }
    return false
  }
  const readyPolls = Math.max(1, Math.ceil((o.readyMs ?? READY_WAIT_MS) / SUBMIT_POLL_MS))
  if (!(await until(async () => (await composer()) === 'empty', readyPolls, true))) {
    return { ok: false, reason: 'not_ready', message: `Node ${nodeId}: the Claude input box is not empty and ready (still starting, a dialog, or a draft); nothing was typed.` }
  }
  const wasWorking = s.statusOf(nodeId) === 'working'
  s.input(nodeId, text.includes('\n') ? `${PASTE_START}${text}${PASTE_END}` : text)
  if (!(await until(async () => (await composer()) === 'draft', SUBMIT_POLLS))) {
    // Enter withheld (it could submit something else); remove the unseen text so the next try starts clean.
    for (let i = 0; i < text.split('\n').length; i++) { s.input(nodeId, KILL_LINE); await sleep(SUBMIT_POLL_MS) }
    const cleared = (await composer()) === 'empty'
    return { ok: false, reason: 'not_on_screen', cleared, message: `Node ${nodeId}: the typed text never showed in the Claude input box; Enter withheld${cleared ? '' : ' and the box could not be cleared'}.` }
  }
  o.beforeEnter?.()
  const started = async (): Promise<boolean> => (await composer()) === 'empty' || (!wasWorking && s.statusOf(nodeId) === 'working')
  for (let i = 0; i < SUBMIT_ENTERS; i++) {
    s.input(nodeId, '\r')
    if (await until(started, SUBMIT_POLLS)) return STARTED
  }
  return { ok: false, reason: 'not_started', message: `Node ${nodeId}: the prompt is in the Claude input box but did not start after ${SUBMIT_ENTERS} Enters.` }
}
