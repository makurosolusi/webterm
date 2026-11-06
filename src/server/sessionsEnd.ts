import type { OpenMsg, ServerMsg } from '../shared/protocol'
import { isSafeNodeId, type Pane } from '../shared/workspace'
import { forgetNodeToken } from './hooks'
import { SessionsCore, exitOutput } from './sessionsCore'
import { ptyLog } from './sessionsLog'
import { producePtyExit } from './events/producers'
import { openFailedNotice } from './sessionsNotices'

/** Every session id of a node: its pane leaves, or the node id itself (client `sessionIdsOf`). */
const leafIds = (p: Pane): string[] => ('a' in p ? [...leafIds(p.a), ...leafIds(p.b)] : [p.id])

/** Ending sessions: close (one node), closeNodes (a deleted workspace) and failOpen (an open that threw). */
export class SessionsEnd extends SessionsCore {
  /** `send` = socket PEMANGGIL close, bukan socket sesi. Opsional supaya pemanggil non-socket tetap
   *  bisa membersihkan node tanpa punya tujuan pengiriman. */
  close(id: string, send?: (m: ServerMsg) => void): void {
    // Token hook dan transcript terikat pada NODE, bukan pada PTY — jadi dilepas SEBELUM gerbang
    // sesi. Agent yang keluar sendiri sudah dihapus dari `map` oleh `onExit`, sehingga `close` yang
    // menyusul tetap harus membersihkannya.
    forgetNodeToken(id)
    this.registry.deleteTranscript(id)
    const session = this.map.get(id)
    // `self` menang: proses yang terbukti keluar sendiri tidak boleh ditimpa `closed`. `closed` hanya
    // mengisi slot kosong — tombol Close pada node yang sudah keluar tidak memancarkan `exit` kedua.
    const firstClose = !this.registry.getExit(id)
    // Stop on a live agent leaves it `stopped` (A5), set BEFORE the tombstone (setStatus skips dead
    // nodes), so the node says what happened and Resume is offered. Anything else drops its status.
    const stopped = firstClose && !!session?.agentId
    if (stopped) this.setStatus(id, 'stopped')
    else this.registry.deleteStatus(id)
    // Output diambil SEBELUM `map.delete`: `OutputLog` hidup di dalam `Session`, dan tombstonenyalah
    // satu-satunya tempat ia bertahan sesudah sesi dibuang.
    if (firstClose) {
      this.registry.setExit(id, { code: -1, reason: 'closed', at: this.now(), output: exitOutput(session?.log) })
    }
    const status: ServerMsg = stopped ? { t: 'status', id, status: 'stopped' } : { t: 'status', id }
    const exit: ServerMsg = { t: 'exit', id, code: -1, reason: 'closed' }
    // `setStatus` already broadcast `stopped` to the session's subscribers.
    if (!stopped) session?.subs.send(status)
    if (firstClose) session?.subs.send(exit)
    // Pencabutan harus sampai ke socket PEMANGGIL juga: kasus restart tidak punya entry `map`.
    // Bila ia sudah jadi pelanggan, broadcast di atas sudah mengirimnya — jangan gandakan.
    const callerHeard = session !== undefined && send !== undefined && session.subs.has(send)
    if (!callerHeard) {
      send?.(status)
      if (firstClose) send?.(exit)
    }
    if (session) {
      ptyLog.exited(id, session.agentId, -1, 'closed', this.now() - session.startedAt)
      if (firstClose) producePtyExit({ nodeId: id, agentId: session.agentId, code: -1, reason: 'closed', durationMs: this.now() - session.startedAt })
      session.subs.clear()
      session.exited = true
      this.map.delete(id)
    }
    // Kill SESUDAH map dihapus: `onExit` digerbangi identitas, jadi gema kematian yang kita minta
    // sendiri tidak pernah menjadi `exit` kedua. Untuk sesi tmux, `pty.kill()` hanya melepas client;
    // sesinya diakhiri `kill`, juga ketika tidak ada entry `map` (node yatim / belum diadopsi).
    // `kill` is synchronous, so an open right after this close creates a NEW tmux session.
    session?.pty.kill()
    this.supervised?.kill(id)
  }

  /** A deleted workspace ends every session of its nodes, panes included (ops-212-3): a browser that
   *  is closed, or another tab, would otherwise leave them running with no node to reach them. Their
   *  statuses go too: no node remains to show one. */
  closeNodes(nodes: readonly { id: string; panes?: Pane }[]): void {
    for (const n of nodes) {
      for (const id of n.panes ? leafIds(n.panes) : [n.id]) {
        this.close(id)
        this.registry.deleteStatus(id)
      }
    }
  }

  /**
   * An `open` that threw before a session existed (A1): the node gets the cause and exactly one exit,
   * so it shows a sticky error instead of staying blank. The exit marks the client's subscription
   * exited, so a reconnect never replays the failed open; only an explicit Retry opens again.
   */
  protected failOpen(msg: OpenMsg, send: (m: ServerMsg) => void, err: unknown): void {
    ptyLog.openFailed(msg.id, err)
    // Unsafe id: `open` never touches it. A live session: the throw came after it was tracked, and
    // its own exit path still reports to the node.
    if (!isSafeNodeId(msg.id) || this.map.has(msg.id)) return
    const output = openFailedNotice(err)
    if (msg.agentId) {
      this.registry.clearExit(msg.id)
      this.setStatus(msg.id, 'failed')
      send({ t: 'status', id: msg.id, status: 'failed' })
    }
    this.registry.setExit(msg.id, { code: -1, reason: 'failed', at: this.now(), output })
    send({ t: 'output', id: msg.id, data: output })
    send({ t: 'exit', id: msg.id, code: -1, reason: 'failed' })
  }
}
