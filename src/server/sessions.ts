import type { ClientMsg, OpenMsg, ServerMsg } from '../shared/protocol'
import { hasClaudeHookSettings, isContextCapable, isSafeNodeId } from '../shared/workspace'
import { binaryExists, leadingBinary, spawnPty, unwrapMissingWrapper } from './pty'
import { NODE_HEADERS_ENV, hookEnv, writeNodeHeaders } from './hooks'
import { CANVAS_OWNER, bootSupervisor } from './ptySupervisor'
import { claudeHeadersPath } from './hooksPaths'
import { resumeIsDead, transcriptMissingNotice } from './transcriptPresence'
import { PORT, launchLine, wrapperMissingNotice } from './launchLine'
import { SessionsAdopt } from './sessionsAdopt'
import { ptyLog } from './sessionsLog'
import { spawnAgent } from './spawn/agentSpawn'
import { createLogger } from './logs'
import { cliPath } from './cli/cli.launcher'
import { delimiter, dirname, join } from 'node:path'
import { resolveShell } from './ptyShell'
import { activeProviderEnv } from './claudeProvider/claudeProvider.store'
import { wrapClaudeLaunch } from './claudeProvider/claudeProvider.launch'
import { applyNodeClaudeProfile, resolveClaudeLaunch } from './claudeLauncher/claudeLauncher'
import { isLegacyClaudeNode } from '../shared/claudeLaunch/claudeLaunch.builtin'
import type { SessionInfo, SessionsOptions } from './sessionsTypes'
import { refuseKind, replay, sameKind } from './sessionsAttach'
import { NODE_STATUS_FILE, StatusStore } from './sessionsStatusStore'
import { missingBinaryText } from './sessionsNotices'
import { locateBinary } from './loginShellPath'
import { dataDir } from './config'
import { recordEvent } from './events/producers'
import { recordLaunchLevel } from './permission/permission.mode'
import type { StaleSweepEntry } from './nodeRegistry'

// `launchLine` dulu tinggal di file ini dan diimpor dari sini oleh test/pemanggil lama. Re-export
// menjaga kontrak itu tanpa memaksa semua pemanggil tahu file barunya.
export { launchLine }

const spawnLog = createLogger('spawn')
/** Shell builtins/keywords a launch line may start with: never on PATH, so never probed (A2). */
const SHELL_WORDS = new Set(['exit', 'exec', 'cd', 'true', 'false', 'echo', 'printf', 'read', 'test', 'eval', 'export', 'set', 'source', '.', 'command', 'builtin', 'if', 'for', 'while', 'until', 'case', 'trap', 'wait', 'ulimit', 'umask'])

// Keadaan sesi (map, registry, jam sweep, emit/onExit) tinggal di `sessionsCore.ts`; tipe-tipenya di
// `sessionsTypes.ts`. Keduanya dipecah hanya karena ukuran file — kontrak publik tetap di sini.
export type { SessionInfo, SessionsOptions }

/** PATH for an agent session: the webterm-owned bin dir (`webterm` CLI) ahead of the server's PATH. */
export const agentPath = (base: string = process.env.PATH ?? ''): string =>
  [dirname(cliPath()), ...base.split(delimiter).filter((p) => p && p !== dirname(cliPath()))].join(delimiter)

/**
 * Jalur socket di atas `SessionsCore` → `SessionsEnd` (close) → `SessionsAdopt` (boot): buka/
 * re-attach, input, resize, dan dispatch pesan client. Dipecah hanya karena ukuran file.
 */
export class Sessions extends SessionsAdopt {
  /**
   * Buka/re-attach sesi untuk sebuah intent `open`.
   *
   * BATAS INPUT: `msg.id` divalidasi dengan `isSafeNodeId` SEBELUM apa pun disentuh. Id yang tidak
   * aman DIABAIKAN — tidak ada PTY yang di-spawn, tidak ada entri `map`/status/token yang dibuat.
   * Id itu mendarat di baris perintah curl hook claude DAN jadi kunci PTY/status, jadi menolak di
   * pintu masuk membuat keduanya tidak pernah melihat nilai berbahaya (`hooks.ts` mengutip sendiri
   * sebagai lapis kedua).
   *
   * Each attach replays to `send` only (never broadcast): the gap after `msg.since` when the client
   * still holds the rest, otherwise reset + the whole log (a remount has a fresh, empty xterm), then
   * a status snapshot. `add` is idempotent. An open of another kind is refused (`sessionsAttach.ts`).
   * `owner` tags a NEW tmux session (`CANVAS_OWNER` from the canvas door) for the orphan reaper.
   */
  open(raw: OpenMsg, send: (m: ServerMsg) => void, owner?: string): void {
    if (!isSafeNodeId(raw.id)) return
    // Recorded Claude launch profile -> the command (server/claudeLauncher); deleted = Default + note.
    // A node from before profiles with the stock command launches with the default profile (the
    // client records it, useLegacyClaudeProfiles); a customised command is left as it is.
    const withProfile = isLegacyClaudeNode(raw) ? { ...raw, claudeProfileId: resolveClaudeLaunch().profile.id } : raw
    const { msg, notice: profileNotice } = applyNodeClaudeProfile(withProfile)
    const existing = this.map.get(msg.id)
    if (existing) {
      if (!sameKind(existing.agentId, msg.agentId)) return refuseKind(msg.id, existing.agentId, msg.agentId, send)
      ptyLog.reattached(msg.id, existing.subs.size())
      existing.subs.add(send)
      replay(existing, send, msg.since)
      send(this.statusMsgOf(msg.id))
      return
    }
    // A tmux session not adopted yet carries its kind in `@webterm-agent`: same gate before attach.
    const held = this.supervised?.holder(msg.id)
    if (held && !sameKind(held.agentId, msg.agentId)) return refuseKind(msg.id, held.agentId, msg.agentId, send)

    // Diprobe SEKALI (filesystem), lalu dipakai dua kali: menjatuhkan `--resume` dan memberi tahu
    // pengguna. Hanya transcript yang TERBUKTI tidak ada yang menjatuhkannya — `transcriptPresence.ts`.
    const deadResume = !!msg.resume && resumeIsDead(msg.sessionId, msg.agentId)
    const launch = msg.agentId && !held ? this.options.launchFor?.(msg.id) : undefined
    let cmd = launchLine(msg, PORT, {
      permissionMode: launch?.mode ?? this.options.claudePermissionMode,
      resumeIsDead: deadResume,
    })
    const notices: string[] = profileNotice ? [profileNotice] : []
    if (deadResume) notices.push(transcriptMissingNotice)
    if (cmd) {
      const unwrapped = unwrapMissingWrapper(cmd, binaryExists)
      if (unwrapped) {
        cmd = unwrapped.cmd
        // Hanya NAMA binary yang hilang yang dilaporkan — baris perintah bisa memuat argumen
        // bermuatan rahasia, jadi ia tidak pernah dicetak maupun dikirim.
        notices.push(wrapperMissingNotice(unwrapped.missing))
      }
      // A2: an agent program missing from PATH fails the open with the preflight's words, before
      // anything spawns. Plain names only (a path or env prefix is left to the shell); a held tmux
      // session ignores `cmd`; an injected spawn (test) runs no program. Login-shell PATH on a miss.
      const bin = msg.agentId && !held && !this.options.spawn ? leadingBinary(cmd) : null
      if (bin && !bin.includes('/') && !SHELL_WORDS.has(bin) && !locateBinary(bin, agentPath())) throw new Error(missingBinaryText(bin))
      // Claude provider (Settings > Capabilities): key/base URL reach THIS claude process only, via a
      // one-shot 0600 file, never argv or the tmux -e list (claudeProvider/claudeProvider.launch.ts).
      if (launch && msg.agentId && hasClaudeHookSettings(msg.agentId)) recordLaunchLevel(msg.id, launch.workspaceId, launch.level)
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
      // `<dataDir>/bin` first on PATH so the `webterm` CLI resolves by name; it carries no token
      // (curl reads the header file above), so this adds a command, not a credential.
      ...(msg.agentId ? { PATH: agentPath() } : {}),
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
      ? supervised.open(msg.id, { ...spawnOpts, agentId: msg.agentId, owner })
      : (this.options.spawn ?? spawnPty)(spawnOpts)
    if (!supervised && this.supervisorNotice) {
      notices.push(this.supervisorNotice)
      this.supervisorNotice = undefined // sekali per proses: cukup untuk terlihat, tidak berisik
    }
    const session = this.track(msg.id, pty, msg.agentId, msg.cols, msg.rows)
    ptyLog.spawned(msg, pty.pid, this.options.shell)
    session.subs.add(send)
    replay(session, send)
    for (const data of notices) this.emit(session, data)

    // PTY baru = hidup baru. Tombstone exit dan status milik sesi sebelumnya dengan id yang sama
    // TIDAK boleh diwarisi: node yang di-restart akan terbaca Done lalu menggerbangi Resume.
    this.registry.clearExit(msg.id)
    this.registry.deleteStatus(msg.id)
    // Selalu dijawab, termasuk ketika yang kita tahu adalah "tidak ada status". Senyap terbaca
    // "tidak berubah" oleh client yang menyimpan salinan status lepas dari socket (restart server).
    // `sendStatus`: every UI socket when wired (the Sessions panel of another tab still shows the
    // old status otherwise); unwired = the subscribers, which now include `send`.
    this.sendStatus(msg.id, { t: 'status', id: msg.id })
  }

  /** Live Claude agent sessions started before `t` (a provider change applies to new sessions only). */
  claudeSessionsStartedBefore(t: number): number {
    return [...this.map.values()].filter((s) => !s.exited && s.startedAt < t && !!s.agentId && hasClaudeHookSettings(s.agentId)).length
  }

  /** Pesan sekali-per-proses saat sesi TIDAK bisa disupervisi (tmux absen); diisi singleton. */
  supervisorNotice?: string

  /** Every viewer's input converges here, so the DA gate covers replay, reconnect and multi-tab. */
  input(id: string, data: string): void {
    const session = this.map.get(id)
    const kept = session?.daReplies.filterInput(data, this.now())
    if (kept) session?.pty.write(kept)
  }

  resize(id: string, cols: number, rows: number): void {
    const session = this.map.get(id)
    if (!session) return
    ptyLog.resized(id, cols, rows)
    session.cols = cols
    session.rows = rows
    session.pty.resize(cols, rows)
  }

  /**
   * Canvas door of `agent.spawn` (F2-h): a NEW agent session opened from the canvas goes through the
   * spawner (door `canvas`, parent `human-ui`) for lineage, events and naming. Re-attach to a live
   * session and plain shells stay direct. The spawner calls `openPty` synchronously (no await before
   * it), so the PTY opens within this call and a spawn error still throws to the caller as before.
   */
  private openFromCanvas(msg: OpenMsg, send: (m: ServerMsg) => void): void {
    if (!msg.agentId || !isSafeNodeId(msg.id) || this.isLive(msg.id)) { this.open(msg, send, CANVAS_OWNER); return }
    let thrown: { err: unknown } | undefined
    const openPty = (): void => {
      try { this.open(msg, send, CANVAS_OWNER) } catch (err) { thrown = { err }; throw err }
    }
    void spawnAgent({ door: 'canvas', mode: 'pty', kind: msg.agentId, parent: 'human-ui', nodeId: msg.id, ...(msg.cwd ? { cwd: msg.cwd } : {}) }, { openPty })
      .then((r) => { if (!r.ok) spawnLog.warn('spawn.canvas.denied', 'canvas agent spawn refused', { code: r.code, ids: { nodeId: msg.id } }) })
      .catch(() => { /* already rethrown synchronously below */ })
    if (thrown) throw thrown.err
  }

  handle(msg: ClientMsg, send: (m: ServerMsg) => void): void {
    switch (msg.t) {
      // A throw here used to leave the node blank and re-run on every reconnect (A1).
      case 'open': try { this.openFromCanvas(msg, send) } catch (err) { this.failOpen(msg, send, err) } break
      case 'input': this.input(msg.id, msg.data); break
      case 'resize': this.resize(msg.id, msg.cols, msg.rows); break
      case 'close': this.close(msg.id, send); break
      case 'detach': this.map.get(msg.id)?.subs.remove(send); break
    }
  }
}

/** Appends one `agent.stale` event for a node the stale sweep removed. */
export function recordAgentStale({ id, idleMs }: StaleSweepEntry): void {
  recordEvent({
    kind: 'agent.stale',
    source: 'pty',
    actor: 'system',
    subject: `node:${id}`,
    nodeId: id,
    trust: 'trusted',
    payload: { rule: 'stale_sweep', lastStatus: 'working', idleMs },
  })
}

const boot = bootSupervisor()
export const sessions = new Sessions({}, boot.supervisor)
sessions.supervisorNotice = boot.notice
// Only with tmux: without it no session outlives the server, so there is nothing to re-seed (A4).
if (boot.supervisor) sessions.statusStore = new StatusStore(join(dataDir(), NODE_STATUS_FILE))
// Jamnya hidup sekali per proses, di singleton — bukan di constructor, supaya `new Sessions()` di
// test tetap bebas timer dan memilih sendiri kapan menyapu.
sessions.onStaleSweep = recordAgentStale
// Status frames reach every UI socket, not only PTY subscribers (sessionsCore `sendStatus`). Lazy:
// canvasPush.runtime opens the db, and a test that only builds this module must not.
let uiPush: typeof import('./canvas/canvasPush.runtime') | undefined
sessions.broadcast = (m) => {
  if (uiPush) return uiPush.broadcastUi(m)
  import('./canvas/canvasPush.runtime').then((r) => { uiPush = r; r.broadcastUi(m) }, (err: unknown) =>
    spawnLog.warn('status.broadcast_failed', 'Status frame not broadcast: UI push unavailable', { ids: { nodeId: 'id' in m ? m.id : undefined }, cause: err instanceof Error ? err.message : String(err) }))
}
sessions.startStaleSweep()

/** Node id yang dikenal workspace mana pun (id pane split `node:pN` ikut node induknya), termasuk
 *  node yang disembunyikan dari board karena tak terbaca (`Db.nodeIds` membaca kolom mentah), jadi
 *  sesinya tidak pernah dicap yatim. Import dinamis: `db.ts` memakai `bun:sqlite`, dan modul ini
 *  juga dimuat test vitest. */
async function knownNodeIds(): Promise<(id: string) => boolean> {
  const { db } = await import('./db')
  const ids = new Set(db.nodeIds())
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
