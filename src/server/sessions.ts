import type { ClientMsg, OpenMsg, ServerMsg } from '../shared/protocol'
import { hasClaudeHookSettings, isContextCapable, isSafeNodeId } from '../shared/workspace'
import { binaryExists, spawnPty, unwrapMissingWrapper, type Pty } from './pty'
import { NODE_HEADERS_ENV, forgetNodeToken, hookEnv, writeNodeHeaders } from './hooks'
import { bootSupervisor } from './ptySupervisor'
import { claudeHeadersPath } from './hooksPaths'
import { resumeIsDead, transcriptMissingNotice } from './transcriptPresence'
import { OutputLog } from './outputLog'
import { SubscriberSet } from './subscribers'
import { PORT, launchLine, wrapperMissingNotice } from './launchLine'
import { SessionsCore, exitOutput } from './sessionsCore'
import { ptyLog } from './sessionsLog'
import { producePtyExit, recordEvent } from './events/producers'
import { spawnAgent } from './spawn/agentSpawn'
import { createLogger } from './logs'
import { mcpEnv } from './mcp/mcp.launch'
import { cliPath } from './cli/cli.launcher'
import { delimiter, dirname } from 'node:path'
import { resolveShell } from './ptyShell'
import { activeProviderEnv } from './claudeProvider/claudeProvider.store'
import { wrapClaudeLaunch } from './claudeProvider/claudeProvider.launch'
import type { Session, SessionInfo, SessionsOptions } from './sessionsTypes'

// `launchLine` dulu tinggal di file ini dan diimpor dari sini oleh test/pemanggil lama. Re-export
// menjaga kontrak itu tanpa memaksa semua pemanggil tahu file barunya.
export { launchLine }

const spawnLog = createLogger('spawn')

// Keadaan sesi (map, registry, jam sweep, emit/onExit) tinggal di `sessionsCore.ts`; tipe-tipenya di
// `sessionsTypes.ts`. Keduanya dipecah hanya karena ukuran file — kontrak publik tetap di sini.
export type { SessionInfo, SessionsOptions }

/** PATH for an agent session: the webterm-owned bin dir (`webterm` CLI) ahead of the server's PATH. */
export const agentPath = (base: string = process.env.PATH ?? ''): string =>
  [dirname(cliPath()), ...base.split(delimiter).filter((p) => p && p !== dirname(cliPath()))].join(delimiter)

/**
 * Jalur socket di atas `SessionsCore`: buka/re-attach, input, resize, close, dan dispatch pesan
 * client. Setiap perilaku (replay scrollback, tombstone exit, gerbang identitas `onExit`) sama
 * persis dengan versi satu-file; yang berubah hanya letak kodenya.
 */
export class Sessions extends SessionsCore {
  /**
   * Buka/re-attach sesi untuk sebuah intent `open`.
   *
   * BATAS INPUT: `msg.id` divalidasi dengan `isSafeNodeId` SEBELUM apa pun disentuh. Id yang tidak
   * aman DIABAIKAN — tidak ada PTY yang di-spawn, tidak ada entri `map`/status/token yang dibuat.
   * Id itu mendarat di baris perintah curl hook claude DAN jadi kunci PTY/status, jadi menolak di
   * pintu masuk membuat keduanya tidak pernah melihat nilai berbahaya (`hooks.ts` mengutip sendiri
   * sebagai lapis kedua).
   *
   * SEMUA pelanggan menerima seluruh scrollback lalu snapshot status, termasuk `send` yang sudah
   * terdaftar. Alasannya: remount meng-dispose dan membuat ulang xterm-nya, jadi buffer di sisi
   * client hilang — tanpa replay layar itu kosong. `add` idempoten, jadi tidak ada langganan ganda;
   * replay hanya dikirim ke `send`, bukan di-broadcast ke pelanggan lain.
   */
  open(msg: OpenMsg, send: (m: ServerMsg) => void): void {
    if (!isSafeNodeId(msg.id)) return
    const existing = this.map.get(msg.id)
    if (existing) {
      ptyLog.reattached(msg.id, existing.subs.size())
      const status = this.registry.getStatus(msg.id)?.status
      existing.subs.add(send)
      for (const chunk of existing.log.since(0)) {
        send({ t: 'output', id: msg.id, data: chunk.data, seq: chunk.seq })
      }
      send({ t: 'status', id: msg.id, status })
      return
    }

    // Diprobe SEKALI (filesystem), lalu dipakai dua kali: menjatuhkan `--resume` dan memberi tahu
    // pengguna. Hanya transcript yang TERBUKTI tidak ada yang menjatuhkannya — `transcriptPresence.ts`.
    const deadResume = !!msg.resume && resumeIsDead(msg.sessionId, msg.agentId)
    let cmd = launchLine(msg, PORT, {
      permissionMode: this.options.claudePermissionMode,
      resumeIsDead: deadResume,
    })
    const notices: string[] = []
    if (deadResume) notices.push(transcriptMissingNotice)
    if (cmd) {
      const unwrapped = unwrapMissingWrapper(cmd, binaryExists)
      if (unwrapped) {
        cmd = unwrapped.cmd
        // Hanya NAMA binary yang hilang yang dilaporkan — baris perintah bisa memuat argumen
        // bermuatan rahasia, jadi ia tidak pernah dicetak maupun dikirim.
        notices.push(wrapperMissingNotice(unwrapped.missing))
      }
      // Claude provider (Settings > Capabilities): key/base URL reach THIS claude process only, via a
      // one-shot 0600 file, never argv or the tmux -e list (claudeProvider/claudeProvider.launch.ts).
      if (msg.agentId && hasClaudeHookSettings(msg.agentId)) cmd = wrapClaudeLaunch(cmd, activeProviderEnv(), resolveShell(this.options.shell))
    }
    // Env sesi agent, digerbangi TERPISAH:
    //  - `WEBTERM_NODE_HEADERS` = PATH file header curl milik node ini (berisi token NODE, bukan
    //    root), untuk SEMUA sesi agent. Shim skill dan hook membaca token lewat `curl -H @file`.
    //    Nilai token sengaja TIDAK masuk env: di macOS env proses ber-uid sama terbaca proses lain
    //    (`KERN_PROCARGS2`, terverifikasi bahkan dari dalam sandbox claude), jadi token di env
    //    = token yang bisa dicuri agent tetangga. File-nya dibuka sandbox claude hanya untuk node ini.
    //  - `NODETERM_NODE_ID`/`NODETERM_PORT` dibaca skill konteks-tertaut di dalam sesi agent.
    //  - `hookEnv` membawa batas tahan hook permission (claude saja).
    // Terminal biasa (tanpa `agentId`) tidak mendapat satu pun: ia tidak butuh kunci apa pun.
    // File ditulis hanya untuk spawn NYATA: spawn ter-inject (test) tidak menjalankan proses apa pun
    // yang membacanya, dan tidak boleh menulis ke data dir pengguna.
    if (msg.agentId && !this.options.spawn) writeNodeHeaders(msg.id)
    const env: Record<string, string> = {
      ...(msg.agentId ? { [NODE_HEADERS_ENV]: claudeHeadersPath(msg.id) } : {}),
      ...(isContextCapable(msg.agentId)
        ? { NODETERM_NODE_ID: msg.id, NODETERM_PORT: String(PORT) }
        : {}),
      ...(msg.agentId && hasClaudeHookSettings(msg.agentId)
        ? hookEnv(msg.id, { hookReplyApprovals: this.options.hookReplyApprovals })
        : {}),
      // `webterm mcp` for CLIs configured through env (opencode, gemini); claude/codex get it as flags
      // in `launchLine`. An injected spawn writes no file (same rule as `writeNodeHeaders` above).
      // `<dataDir>/bin` first on PATH so the `webterm` CLI resolves by name; it carries no token
      // (curl reads the header file above), so this adds a command, not a credential.
      ...(msg.agentId ? { PATH: agentPath() } : {}),
      ...(msg.agentId ? mcpEnv(msg.agentId, msg.id, PORT, this.options.spawn ? () => {} : undefined) : {}),
    }
    const spawnOpts = {
      cols: msg.cols,
      rows: msg.rows,
      cwd: msg.cwd,
      cmd,
      shell: this.options.shell,
      env: Object.keys(env).length ? env : undefined,
    }
    // Supervisor: sesi tmux yang sudah hidup (server baru restart, adopsi belum sempat) DITEMPELI,
    // bukan dibuat ulang — `cmd`/`env` hanya berlaku saat create.
    const supervised = this.supervised
    const pty = supervised
      ? supervised.open(msg.id, { ...spawnOpts, agentId: msg.agentId })
      : (this.options.spawn ?? spawnPty)(spawnOpts)
    if (!supervised && this.supervisorNotice) {
      notices.push(this.supervisorNotice)
      this.supervisorNotice = undefined // sekali per proses: cukup untuk terlihat, tidak berisik
    }
    const session = this.track(msg.id, pty, msg.agentId, msg.cols, msg.rows)
    ptyLog.spawned(msg, pty.pid, this.options.shell)
    session.subs.add(send)
    for (const data of notices) this.emit(session, data)

    // PTY baru = hidup baru. Tombstone exit dan status milik sesi sebelumnya dengan id yang sama
    // TIDAK boleh diwarisi: node yang di-restart akan terbaca Done lalu menggerbangi Resume.
    this.registry.clearExit(msg.id)
    this.registry.deleteStatus(msg.id)
    // Selalu dijawab, termasuk ketika yang kita tahu adalah "tidak ada status". Senyap terbaca
    // "tidak berubah" oleh client yang menyimpan salinan status lepas dari socket (restart server).
    send({ t: 'status', id: msg.id })
  }

  /** Live Claude agent sessions started before `t` (a provider change applies to new sessions only). */
  claudeSessionsStartedBefore(t: number): number {
    return [...this.map.values()].filter((s) => !s.exited && s.startedAt < t && !!s.agentId && hasClaudeHookSettings(s.agentId)).length
  }

  /** Pesan sekali-per-proses saat sesi TIDAK bisa disupervisi (tmux absen); diisi singleton. */
  supervisorNotice?: string

  /** Daftarkan PTY hidup sebagai sesi node dan sambungkan output/exit-nya. */
  private track(id: string, pty: Pty, agentId: string | undefined, cols: number, rows: number): Session {
    const session: Session = {
      id, pty, agentId, cols, rows,
      log: new OutputLog(),
      subs: new SubscriberSet<ServerMsg>(),
      exited: false,
      startedAt: this.now(),
    }
    this.map.set(id, session)
    pty.onData((data) => this.emit(session, data))
    pty.onExit((code) => {
      // Same identity gate as `onExit`: only the first exit of the live session becomes an event.
      const live = this.map.get(id) === session && !session.exited
      this.onExit(session, code)
      if (live) producePtyExit({ nodeId: id, agentId, code, reason: 'self', durationMs: this.now() - session.startedAt })
    })
    return session
  }

  /**
   * Boot: tempelkan lagi setiap sesi tmux yang selamat dari server sebelumnya, SEBELUM browser
   * menyambung ulang — output terus terekam, dan agent yang memanggil hook tetap terautentikasi
   * karena file header token-nya ditulis ulang dengan token proses ini (token hidup di memori, jadi
   * token lama mati bersama server lama). Ukuran dipulihkan dari window tmux itu sendiri, dan
   * history pane di-seed ke log supaya scrollback client yang menyambung ulang tetap utuh.
   *
   * Sesi yang node-nya tidak dikenal (`isKnown` false) ditandai yatim lewat `markOrphan` dan TIDAK
   * ditempeli. `open` untuk node itu nanti tetap menempel ke sesinya.
   */
  adoptSupervised(isKnown: (id: string) => boolean = () => true): { adopted: string[]; orphans: string[] } {
    const supervisor = this.supervised
    const adopted: string[] = []
    const orphans: string[] = []
    if (!supervisor) return { adopted, orphans }
    for (const s of supervisor.list()) {
      if (this.map.has(s.id) || !isSafeNodeId(s.id)) continue
      if (!isKnown(s.id)) {
        supervisor.markOrphan(s.id, this.now())
        orphans.push(s.id)
        continue
      }
      if (s.agentId) writeNodeHeaders(s.id)
      const history = s.history > 0 ? supervisor.capture(s.id, { escapes: true, screen: false }) : undefined
      const session = this.track(s.id, supervisor.attach(s.id, s.cols, s.rows), s.agentId, s.cols, s.rows)
      if (history) this.emit(session, history.replace(/\r?\n/g, '\r\n'))
      // Morning brief (F3-e): an agent that kept running through the restart is reported as restored.
      if (s.agentId) recordEvent({ kind: 'agent.restored', source: 'pty', subject: `node:${s.id}`, nodeId: s.id, trust: 'trusted', payload: { agentId: s.agentId } })
      adopted.push(s.id)
    }
    if (adopted.length || orphans.length) ptyLog.adopted(adopted.length, orphans.length)
    return { adopted, orphans }
  }

  input(id: string, data: string): void {
    this.map.get(id)?.pty.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const session = this.map.get(id)
    if (!session) return
    ptyLog.resized(id, cols, rows)
    session.cols = cols
    session.rows = rows
    session.pty.resize(cols, rows)
  }

  /** `send` = socket PEMANGGIL close, bukan socket sesi. Opsional supaya pemanggil non-socket tetap
   *  bisa membersihkan node tanpa punya tujuan pengiriman. */
  close(id: string, send?: (m: ServerMsg) => void): void {
    // Token hook, status dan transcript terikat pada NODE, bukan pada PTY — jadi ketiganya dilepas
    // SEBELUM gerbang sesi. Agent yang keluar sendiri sudah dihapus dari `map` oleh `onExit`,
    // sehingga `close` yang menyusul tetap harus membersihkannya.
    forgetNodeToken(id)
    this.registry.deleteStatus(id)
    this.registry.deleteTranscript(id)
    const session = this.map.get(id)
    // `self` menang: proses yang terbukti keluar sendiri tidak boleh ditimpa `closed`. `closed` hanya
    // mengisi slot kosong — tombol Close pada node yang sudah keluar tidak memancarkan `exit` kedua.
    const firstClose = !this.registry.getExit(id)
    // Output diambil SEBELUM `map.delete`: `OutputLog` hidup di dalam `Session`, dan tombstoneyalah
    // satu-satunya tempat ia bertahan sesudah sesi dibuang.
    if (firstClose) {
      this.registry.setExit(id, {
        code: -1,
        reason: 'closed',
        at: this.now(),
        output: exitOutput(session?.log),
      })
    }
    const status: ServerMsg = { t: 'status', id }
    const exit: ServerMsg = { t: 'exit', id, code: -1, reason: 'closed' }
    session?.subs.send(status)
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
    session?.pty.kill()
    this.supervised?.kill(id)
  }

  /**
   * Canvas door of `agent.spawn` (F2-h): a NEW agent session opened from the canvas goes through the
   * spawner (door `canvas`, parent `human-ui`) for lineage, events and naming. Re-attach to a live
   * session and plain shells stay direct. The spawner calls `openPty` synchronously (no await before
   * it), so the PTY opens within this call and a spawn error still throws to the caller as before.
   */
  private openFromCanvas(msg: OpenMsg, send: (m: ServerMsg) => void): void {
    if (!msg.agentId || !isSafeNodeId(msg.id) || this.isLive(msg.id)) { this.open(msg, send); return }
    let thrown: { err: unknown } | undefined
    const openPty = (): void => {
      try { this.open(msg, send) } catch (err) { thrown = { err }; throw err }
    }
    void spawnAgent({ door: 'canvas', mode: 'pty', kind: msg.agentId, parent: 'human-ui', nodeId: msg.id, ...(msg.cwd ? { cwd: msg.cwd } : {}) }, { openPty })
      .then((r) => { if (!r.ok) spawnLog.warn('spawn.canvas.denied', 'canvas agent spawn refused', { code: r.code, ids: { nodeId: msg.id } }) })
      .catch(() => { /* already rethrown synchronously below */ })
    if (thrown) throw thrown.err
  }

  handle(msg: ClientMsg, send: (m: ServerMsg) => void): void {
    switch (msg.t) {
      case 'open': this.openFromCanvas(msg, send); break
      case 'input': this.input(msg.id, msg.data); break
      case 'resize': this.resize(msg.id, msg.cols, msg.rows); break
      case 'close': this.close(msg.id, send); break
    }
  }
}

const boot = bootSupervisor()
export const sessions = new Sessions({}, boot.supervisor)
sessions.supervisorNotice = boot.notice
// Jamnya hidup sekali per proses, di singleton — bukan di constructor, supaya `new Sessions()` di
// test tetap bebas timer dan memilih sendiri kapan menyapu.
sessions.startStaleSweep()

/** Node id yang dikenal workspace mana pun (id pane split `node:pN` ikut node induknya). Import
 *  dinamis: `db.ts` memakai `bun:sqlite`, dan modul ini juga dimuat test vitest. */
async function knownNodeIds(): Promise<(id: string) => boolean> {
  const { db } = await import('./db')
  const ids = new Set(db.list().flatMap((w) => w.nodes.map((n) => n.id)))
  return (id) => ids.has(id.split(':')[0] ?? id)
}

if (boot.supervisor) {
  void knownNodeIds()
    .catch((err: unknown) => {
      // Tanpa daftar node, tidak ada yang boleh dicap yatim: semua sesi diadopsi.
      ptyLog.adoptKnownFailed(err)
      return () => true
    })
    .then((isKnown) => sessions.adoptSupervised(isKnown))
    // Adopsi gagal tidak mematikan server: sesi tmux tetap hidup, dan `open` dari browser tetap
    // menempel ke sana satu per satu.
    .catch((err: unknown) => ptyLog.adoptFailed(err))
}
