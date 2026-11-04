import type { AgentPermissionMode, AgentStatus } from '../shared/workspace'
import type { OutputLog } from './outputLog'
import type { Pty, spawnPty } from './pty'
import type { SubscriberSet } from './subscribers'
import type { ServerMsg } from '../shared/protocol'

/** Satu PTY hidup beserta jalur observasinya: log output bernomor urut dan kumpulan pelanggan. */
export interface Session {
  id: string
  pty: Pty
  log: OutputLog
  subs: SubscriberSet<ServerMsg>
  exited: boolean
  /** Waktu spawn (ms) untuk durasi di log `pty.exit`. */
  startedAt: number
  /** Agent harness sesi ini (kosong = terminal biasa); dipakai log `agent.*`. */
  agentId?: string
  /** Current PTY size (open + every resize): the screen `screenSource` is rebuilt at. */
  cols: number
  rows: number
}

/** Ringkasan sesi hidup untuk endpoint/panel daftar. Tanpa tombstone: sesi yang sudah keluar tidak
 *  pernah muncul di sini (pakai `getExit`/`statusOf` untuk fakta sesudah mati). */
export interface SessionInfo {
  id: string
  pid: number
  status?: AgentStatus
}

/** Knob runtime yang disambungkan integrator dari store settings. Absen = default hari ini, jadi
 *  `new Sessions()` berperilaku persis seperti sebelum settings ada. */
export interface SessionsOptions {
  /** Shell untuk PTY baru. Kosong = default sistem (`settings.defaultShell`). */
  shell?: string
  /** Batas ring buffer scrollback dalam BYTE (`settings.scrollbackBytes`). */
  scrollbackBytes?: number
  /** Mode permission awal sesi claude (`settings.claudePermissionMode`). Absen = tidak ada flag
   *  `--permission-mode` sama sekali, sehingga peluncuran tetap polos selama integrator belum
   *  menyambungkan settings. */
  claudePermissionMode?: AgentPermissionMode
  /** `settings.hookReplyApprovals`. Absen/false = `NODETERM_PERM_WAIT_SECS` tidak dikirim, jadi hook
   *  permission tidak menahan apa pun — perilaku sebelum setting ini ada. */
  hookReplyApprovals?: boolean
  /** Sumber PTY. Di-inject supaya test bisa memakai PTY palsu tanpa `Bun.Terminal`. */
  spawn?: typeof spawnPty
  /** Sumber waktu untuk tombstone exit. Di-inject supaya test tidak bergantung jam dinding. */
  now?: () => number
}
