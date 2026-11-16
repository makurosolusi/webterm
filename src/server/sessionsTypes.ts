import type { AgentPermissionMode, AgentStatus } from '../shared/workspace'
import type { ApprovalLevel } from '../shared/settings.approvalLevel'
import type { OutputLog } from './outputLog'
import type { Pty, spawnPty } from './pty'
import type { SubscriberSet } from './subscribers'
import type { ServerMsg } from '../shared/protocol'
import type { DaReplyGate } from './daReplyGate'

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
  /** Names this session's log: `seq` restarts at 1 per log, so a client's seq is only valid with it. */
  epoch: string
  /** One DA answer per DA query on this session's input (pty-207-1). */
  daReplies: DaReplyGate
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
   *  `--permission-mode` (hanya sebelum `applyPtyOptions` jalan / di test). */
  claudePermissionMode?: AgentPermissionMode
  /** Per-node launch: the mode for the node's workspace (its approval level). Absent = `claudePermissionMode`. */
  launchFor?: (nodeId: string) => { mode: AgentPermissionMode; workspaceId: string | null; level: ApprovalLevel }
  /** Unused since the env-based permission-wait injection was removed (the hold is
   *  `PERM_WAIT_SECS_INTERACTIVE` in hooksSettings.ts). Remove with api.ts:86 and sessions.ts:105. */
  hookReplyApprovals?: boolean
  /** Sumber PTY. Di-inject supaya test bisa memakai PTY palsu tanpa `Bun.Terminal`. */
  spawn?: typeof spawnPty
  /** Sumber waktu untuk tombstone exit. Di-inject supaya test tidak bergantung jam dinding. */
  now?: () => number
}
