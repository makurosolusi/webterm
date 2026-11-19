// Perakitan baris peluncuran sebuah intent `open` — murni (tanpa PTY, tanpa sesi) supaya grammar
// flag per agent bisa dites langsung. Dipisah dari `sessions.ts` agar sesi hanya memegang PTY,
// subscriber, dan output log (batas 300 baris), dan supaya modul ini tidak menarik `Bun` sama sekali.

import type { OpenMsg } from '../shared/protocol'
import type { AgentPermissionMode } from '../shared/workspace'
import {
  canResumeWith,
  hasClaudeHookSettings,
  isSafeSessionId,
  resumeCommandWith,
  withSessionId,
} from '../shared/workspace'
import { buildClaudeFlags } from './hooks'
import { parsePort } from './serverConfig'

/** Port yang ditulis ke env hook agent bila pemanggil tidak menyebutkannya. */
export const PORT = parsePort(process.env.PORT)

/** Catatan peluncuran yang terlihat pengguna, ditulis ke stream terminal. Bahasa Inggris supaya
 *  seragam dengan `[process exited]` di client. */
export const wrapperMissingNotice = (bin: string, incompatible?: string | null): string =>
  incompatible
    ? `\r\n[webterm] ${incompatible} — launched without it.\r\n`
    : `\r\n[webterm] '${bin}' was not found — launched without it. If you just installed it, run "webterm command rescan" (or Rescan in Settings).\r\n`

/**
 * Baris peluncuran final untuk sebuah intent open: perintah dasar client plus flag session-id /
 * resume sesuai grammar agent-nya. Murni (tanpa PTY) supaya perakitan flag bisa dites langsung.
 *
 * Grammar TIDAK dirakit di sini — ia milik `src/shared/workspace.ts` (`withSessionId`,
 * `resumeCommandWith`). Agent tanpa kapabilitas (CLI lain yang dijalankan sebagai program terminal
 * biasa, termasuk node warisan `agentId: 'codex'`) mendapat `cmd` apa adanya, tanpa flag tambahan.
 *
 * CATATAN RISIKO (sengaja): tidak ada probe versi CLI per agent sebelum minting session id;
 * dipakai `SESSION_ID_CAPABLE` apa adanya. Risikonya terbatas: CLI lama menolak flag di peluncuran
 * PERTAMA, bukan merusak state. Kalau muncul di lapangan, tambahkan probe-nya — jangan diam-diam
 * mengecilkan daftar kapabilitas.
 */
export function launchLine(
  msg: OpenMsg,
  port = PORT,
  opts?: { permissionMode?: AgentPermissionMode; resumeIsDead?: boolean }
): string | undefined {
  const cmd = msg.cmd
  if (!cmd) return undefined
  const agentId = msg.agentId
  const sid = msg.sessionId?.trim()
  // Transcript yang sudah hilang = resume yang membunuh node di peluncuran; keputusannya diprobe
  // oleh pemanggil (fungsi ini tetap murni) — alasan lengkapnya di `transcriptPresence.ts`.
  const resume = !!msg.resume && !opts?.resumeIsDead
  // Session id mendarat di baris perintah shell dan datang lewat WebSocket, jadi divalidasi ulang
  // di sini — batas input, bukan sekadar janji tipe.
  if (!agentId || !sid || !isSafeSessionId(sid, true)) return cmd

  // `buildClaudeFlags` memancarkan flag id claude, `--permission-mode` dan `--settings` sebagai satu
  // unit, dan ketiganya grammar claude — jadi gerbangnya daftar kapabilitas, bukan nama agent.
  // `--settings` membawa PATH file settings yang baru ditulis, bukan blob JSON inline (alasannya di
  // `writeClaudeSettings`, hooks.ts) — jadi peluncuran ini menyentuh disk, bukan sekadar merakit string.
  if (hasClaudeHookSettings(agentId)) {
    return `${cmd} ${buildClaudeFlags(msg.id, sid, port, resume, {
      permissionMode: opts?.permissionMode,
    })}`
  }
  if (resume) {
    // Perintah client dipakai utuh sebagai program, jadi pembungkus apa pun tetap terpasang.
    return canResumeWith(agentId, sid) ? resumeCommandWith(cmd, agentId, sid) ?? cmd : cmd
  }
  return withSessionId(cmd, agentId, sid)
}
