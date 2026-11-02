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

/** Port yang ditulis ke env hook agent bila pemanggil tidak menyebutkannya. */
export const PORT = Number(process.env.PORT) || 8700

/** Catatan peluncuran yang terlihat pengguna, ditulis ke stream terminal. Bahasa Inggris supaya
 *  seragam dengan `[process exited]` di client. */
export const wrapperMissingNotice = (bin: string): string =>
  `\r\n[webterm] '${bin}' is not installed — launching the agent command without that wrapper.\r\n`

/**
 * Baris peluncuran final untuk sebuah intent open: perintah dasar client plus flag session-id /
 * resume sesuai grammar agent-nya. Murni (tanpa PTY) supaya perakitan flag bisa dites langsung.
 *
 * Grammar TIDAK dirakit di sini — ia milik `src/shared/workspace.ts` (`withSessionId`,
 * `resumeCommandWith`), karena bentuknya beda per harness: `copilot` memakai `--session-id=<sid>`
 * dan `cursor` sama sekali tidak punya flag itu (ia mengadopsi id lewat `--resume <uuid-baru>`).
 *
 * CATATAN RISIKO (beda dari nodeterm, sengaja): nodeterm menggerbangi minting session id di balik
 * probe versi CLI per agent (`supportsSessionIdFlag`, yang menyelidiki `claude --version` dan
 * `grok --help` terpisah — diverifikasi di source v0.4.5). webterm tidak memprobe sama sekali dan
 * memakai `SESSION_ID_CAPABLE` apa adanya. Risikonya terbatas: CLI lama menolak flag di peluncuran
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
