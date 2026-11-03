import { agentConfig, AGENT_CONFIG, type AgentId, type BuiltinAgentId } from './workspace.agents'
import { canResume, capabilityAgentId, mintsSessionId } from './workspace.capabilities'
import { isSafeSessionId } from './workspace.ids'
import type { CustomAgent } from './settings'

// ---------------------------------------------------------------------------------------------
// Grammar peluncuran & resume.

/**
 * Menempelkan flag session-id yang dicetak sendiri ke perintah PELUNCURAN PERTAMA, untuk agent di
 * `SESSION_ID_CAPABLE`. Selain itu — agent lain, id kosong atau tidak aman — mengembalikan `cmd`
 * apa adanya, jadi baris perintah yang tidak berhak membawa flag tetap identik byte demi byte.
 *
 * PELUNCURAN PERTAMA SAJA. `claude --session-id <uuid>` menolak id yang sudah ada ("Session ID …
 * is already in use."), jadi peluncuran ulang node yang sama harus resume — itu tugas
 * `resumeCommand`, dan dua bentuk ini tidak bisa dilipat jadi satu perintah idempoten.
 */
export function withSessionId(cmd: string, id: AgentId, sessionId: string): string {
  if (!mintsSessionId(id)) return cmd
  if (!isSafeSessionId(sessionId)) return cmd
  const sid = sessionId.trim()
  const base = capabilityAgentId(id)
  if (base === 'copilot') return `${cmd} --session-id=${sid}`
  // cursor tidak punya flag session-id: `--resume <uuid> yang belum ada` membuka chat kosong yang
  // MENGADOPSI id itu. Ia root option, jadi letaknya sebelum subcommand.
  if (base === 'cursor') return `${cmd} --resume ${sid}`
  return `${cmd} --session-id ${sid}`
}

/**
 * Resume berdasarkan session id provider, memakai `launchCmd` sebagai binary dan `grammarId` untuk
 * memilih grammar flag resume. `grammarId` adalah BASE harness untuk agent custom yang mewarisi
 * (`capabilityAgentId(agentId)`), sehingga agent custom berbasis claude resume sebagai
 * `<customLaunchCmd> --resume <sid>` — binary-nya sendiri, flag claude. Mengembalikan null untuk
 * base yang tidak resumable atau session id kosong/tidak aman.
 */
export function resumeCommandWith(
  launchCmd: string,
  grammarId: AgentId,
  sessionId: string
): string | null {
  if (!canResume(grammarId)) return null
  if (!isSafeSessionId(sessionId)) return null
  const sid = sessionId.trim()
  switch (capabilityAgentId(grammarId)) {
    case 'codex':
      return `${launchCmd} resume ${sid}`
    case 'opencode':
      return `${launchCmd} --session ${sid}`
    case 'copilot':
      return `${launchCmd} --resume=${sid}`
    case 'antigravity':
      return `${launchCmd} --conversation=${sid}`
    case 'claude':
    case 'gemini':
    case 'grok':
    case 'cursor':
      return `${launchCmd} --resume ${sid}`
    default:
      return null
  }
}

/**
 * Perintah yang me-resume percakapan sebelumnya sebuah agent resumable. Dipakai pada restart
 * dingin, di mana sesi dan agent-nya sudah hilang sehingga percakapan harus direkonstruksi lewat
 * `--resume` milik CLI agent itu sendiri.
 *
 * `base` adalah override perintah peluncuran milik pengguna (`settings.agentLaunchCommands`,
 * mis. wrapper pemilih akun) — DIKIRIMKAN, bukan dibaca di sini: modul ini tidak boleh menjangkau
 * store settings. Bila diisi (tidak kosong) ia mengganti bagian program secara utuh.
 */
export function resumeCommand(id: AgentId, sessionId: string, base?: string): string | null {
  const program = base?.trim() || agentConfig(capabilityAgentId(id))?.launchCmd
  if (!program) return null
  return resumeCommandWith(program, id, sessionId)
}

/** Apakah `sessionId` akan dipasang ke baris `--resume` untuk `id`? Gerbang kelayakan untuk
 *  koreografi restart TANPA membangun perintahnya (yang untuk agent custom butuh `launchCmd` dari
 *  settings, tidak tersedia di sini). Sadar-pewarisan lewat `canResume`. */
export function canResumeWith(id: AgentId, sessionId: string): boolean {
  return canResume(id) && isSafeSessionId(sessionId)
}

/**
 * Bangun baris perintah peluncuran agent: override milik pengguna bila ada
 * (`settings.agentLaunchCommands[agentId]`, mis. skrip pemilih akun), selain itu `launchCmd`
 * builtin. `base` DIKIRIMKAN, bukan dibaca di sini — modul ini tidak boleh menjangkau store
 * settings, persis seperti parameter `base` di `resumeCommand`.
 *
 * Perintah ini nantinya dijalankan via login shell, jadi string biasa sudah benar — JANGAN
 * dipecah jadi argv lebih dulu.
 *
 * TIDAK ADA pembungkus yang dihasilkan di sini. nodeterm tidak pernah membungkus perintah agent
 * (nol kemunculan wrapper semacam itu di source v0.4.5); pemilihan akun/profil adalah urusan
 * override di atas, yang dikarang pengguna sendiri sehingga binary-nya pasti ada di mesinnya.
 */
export function assembleCmd(agentId: BuiltinAgentId, base?: string): string {
  return base?.trim() || AGENT_CONFIG[agentId].launchCmd
}

/** Baris peluncuran agent custom: `launchCmd` sendiri, kalau kosong perintah base (termasuk override pengguna), kalau tak ada keduanya string kosong. */
export function customLaunchCmd(agent: CustomAgent, cmds: Partial<Record<BuiltinAgentId, string>>): string {
  return agent.launchCmd.trim() || (agent.baseAgent ? assembleCmd(agent.baseAgent, cmds[agent.baseAgent]) : '')
}
