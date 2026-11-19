import { isSafeNodeId } from '../shared/workspace'
import { writeNodeHeaders } from './hooks'
import { recordEvent } from './events/producers'
import { SessionsEnd } from './sessionsEnd'
import { ptyLog } from './sessionsLog'
import { CANVAS_OWNER, CLAUDE_MOUSE_AGENT } from './ptySupervisor'

/** How long a canvas session no stored node owns survives before a boot ends it (ops-212-3). Long
 *  enough that a layout saved late, or a restore from backup, still finds its agent alive. */
export const ORPHAN_REAP_GRACE_MS = 24 * 60 * 60 * 1000

/** Seed pieces stay far below the log cap: the log evicts whole chunks, so one big seed chunk would
 *  be dropped entirely by the first redraw and leave a reattached client with only the screen. */
const SEED_CHUNK_BYTES = 16 * 1024

/** Split `text` into pieces of about SEED_CHUNK_BYTES, cut only after a newline. */
export function splitSeed(text: string): string[] {
  const parts: string[] = []
  for (let from = 0; from < text.length;) {
    let to = Math.min(from + SEED_CHUNK_BYTES, text.length)
    if (to < text.length) {
      const nl = text.indexOf('\n', to)
      to = nl === -1 ? text.length : nl + 1
    }
    parts.push(text.slice(from, to))
    from = to
  }
  return parts
}

/** Boot-time re-adoption of tmux sessions, with their last status and the two-phase orphan reaper. */
export class SessionsAdopt extends SessionsEnd {
  /**
   * Boot: tempelkan lagi setiap sesi tmux yang selamat dari server sebelumnya, SEBELUM browser
   * menyambung ulang — output terus terekam, dan agent yang memanggil hook tetap terautentikasi
   * karena file header token-nya ditulis ulang dengan token proses ini. Ukuran dipulihkan dari
   * window tmux itu sendiri, dan history pane di-seed ke log supaya scrollback client tetap utuh.
   * The last status of each adopted node comes back from the status store (A4).
   *
   * A session no stored node owns (`isKnown` false) is not attached. Two phases: the first boot that
   * sees it marks it orphan; a later boot, `ORPHAN_REAP_GRACE_MS` after that mark, ends it — but only
   * a session the canvas created (`@webterm-owner`). Central agents, workers and sessions from before
   * the owner tag are never workspace nodes, so they are only marked, never ended.
   */
  adoptSupervised(isKnown: (id: string) => boolean = () => true): { adopted: string[]; orphans: string[]; reaped: string[] } {
    const supervisor = this.supervised
    const adopted: string[] = []
    const orphans: string[] = []
    const reaped: string[] = []
    if (!supervisor) return { adopted, orphans, reaped }
    const saved = this.statusStore?.load()
    const now = this.now()
    for (const s of supervisor.list()) {
      if (this.map.has(s.id) || !isSafeNodeId(s.id)) continue
      if (!isKnown(s.id)) {
        if (s.owner === CANVAS_OWNER && s.orphanAt !== undefined && now - s.orphanAt >= ORPHAN_REAP_GRACE_MS) {
          supervisor.kill(s.id)
          reaped.push(s.id)
        } else {
          // Marked once: re-marking every boot would restart the grace and nothing would ever end.
          if (s.orphanAt === undefined) supervisor.markOrphan(s.id, now)
          orphans.push(s.id)
        }
        continue
      }
      // Owned again (a layout saved after the mark): the grace must not carry over to a later boot.
      if (s.orphanAt !== undefined) supervisor.clearOrphan(s.id)
      if (s.agentId) writeNodeHeaders(s.id)
      if (s.agentId === CLAUDE_MOUSE_AGENT) supervisor.mouseOn(s.id) // sessions made before mouse-on existed
      const history = s.history > 0 ? supervisor.capture(s.id, { escapes: true, screen: false }) : undefined
      const session = this.track(s.id, supervisor.attach(s.id, s.cols, s.rows), s.agentId, s.cols, s.rows)
      if (history) for (const part of splitSeed(history.replace(/\r?\n/g, '\r\n'))) this.emit(session, part)
      const last = saved?.get(s.id)
      if (last) this.registry.setStatus(s.id, last.status, last.updatedAt)
      // Morning brief (F3-e): an agent that kept running through the restart is reported as restored.
      if (s.agentId) recordEvent({ kind: 'agent.restored', source: 'pty', subject: `node:${s.id}`, nodeId: s.id, trust: 'trusted', payload: { agentId: s.agentId } })
      adopted.push(s.id)
    }
    if (adopted.length || orphans.length) ptyLog.adopted(adopted.length, orphans.length)
    if (reaped.length) ptyLog.reaped(reaped.length)
    return { adopted, orphans, reaped }
  }
}
