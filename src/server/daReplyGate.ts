/**
 * Duplicate-answer filter for terminal "Device Attributes" (DA1 `ESC[c`, DA2 `ESC[>c`) queries.
 *
 * Problem: a session can have several viewers (browser tabs, a node plus a modal, a relay peer).
 * The pty output reaches every one of their emulators, and each emulator answers the query. The
 * program that asked (tmux, a shell, an agent) only consumes one answer in time; the rest arrive
 * as typed input and show up as garbage such as `1;2c0;276;0c` at a prompt.
 *
 * Approach: every query seen in pty OUTPUT opens a "credit" of its kind (stamped with the time).
 * A viewer write that consists purely of DA replies must spend one live credit per reply; replies
 * with no credit are dropped. Credits older than the TTL are dead, because the asker has stopped
 * waiting by then. Any other write (keystrokes, pastes, mixed data) is never touched: emulators
 * send each reply as its own event, and no key sequence looks like a DA reply, so nothing typed
 * can be swallowed. The gate stays armed for the whole session, so later queries get an answer too.
 */

/** For a real tmux client: slightly under tmux's own ~5 s wait for an answer. */
export const DA_REPLY_TTL_TMUX_MS = 4_000
/** For anything else the asker's patience is unknown, so allow a long window. */
export const DA_REPLY_TTL_OTHER_MS = 30_000

type DaKind = 'primary' | 'secondary'

/** Upper bound of unanswered queries remembered per kind; the oldest is forgotten first. */
const MAX_PENDING_PER_KIND = 32

const QUERY_PATTERN = /\x1b\[(>?)0?c/g
const REPLY_PATTERN = /\x1b\[([?>])[\d;]*c/g
// Ways a chunk can end in the middle of a query; the rest arrives with the next chunk.
const QUERY_PREFIXES = ['\x1b[>0', '\x1b[>', '\x1b[0', '\x1b[', '\x1b']

const kindOf = (marker: string): DaKind => (marker === '>' ? 'secondary' : 'primary')

export class DaReplyGate {
  private readonly pending: Record<DaKind, number[]> = { primary: [], secondary: [] }
  private tail = ''

  constructor(private readonly ttlMs: number) {}

  /** Record the queries found in a chunk of pty output. */
  noteOutput(chunk: string, now: number): void {
    if (!chunk) return
    const text = this.tail + chunk
    this.tail = ''
    if (!text.includes('\x1b')) return
    for (const hit of text.matchAll(QUERY_PATTERN)) {
      const list = this.pending[kindOf(hit[1])]
      list.push(now)
      if (list.length > MAX_PENDING_PER_KIND) list.shift()
    }
    this.tail = QUERY_PREFIXES.find((p) => text.endsWith(p)) ?? ''
  }

  /**
   * Decide what of a viewer's write reaches the pty. Anything that is not purely DA replies passes
   * through as is; for a pure reply write only the replies that have a live credit are kept.
   */
  filterInput(data: string, now: number): string {
    if (!data.startsWith('\x1b')) return data
    const replies = data.match(REPLY_PATTERN)
    if (!replies || replies.join('') !== data) return data
    return replies.filter((r) => this.spend(kindOf(r[2]), now)).join('')
  }

  private spend(kind: DaKind, now: number): boolean {
    const list = this.pending[kind]
    const firstLive = list.findIndex((at) => now - at <= this.ttlMs)
    if (firstLive === -1) {
      list.length = 0
      return false
    }
    list.splice(0, firstLive + 1)
    return true
  }
}
