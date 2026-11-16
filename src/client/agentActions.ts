// Helper MURNI untuk aksi siklus-hidup sebuah node agent: meminta CLI keluar baik-baik, lalu
// meluncurkannya ulang dengan `--resume` miliknya sendiri sehingga percakapannya kembali utuh.
// Bebas DOM/transport supaya context menu, koreografi restart, dan test memakai SATU set aturan.
//
// Logika restart agent. Yang TIDAK tercakup:
// polling pane tmux (`performExitPhase`). webterm menjalankan agent sebagai `shell -l -c "<cmd>"`,
// jadi saat CLI keluar shell-nya keluar juga dan PTY-nya habis — tidak ada pane shell untuk
// diintip atau diketik. Lihat `AgentNode` untuk bagaimana fase relaunch-nya diisi.

import { canResume, capabilityAgentId, isSafeSessionId, type AgentId, type AgentStatus } from '../shared/workspace'

/**
 * Perintah exit in-band per CLI agent. Hanya agent yang terdaftar di sini yang bisa di-restart
 * in-place — CLI tak dikenal (termasuk CLI non-Claude yang dijalankan di terminal) tidak punya cara
 * aman untuk diminta keluar. Nilainya `EXIT_SEQUENCES`.
 */
const EXIT_SEQUENCES: Record<string, string> = { claude: '/exit' }

/**
 * Berapa Ctrl-C yang mengeluarkan agent. Diukur terhadap binary terpasang: satu Ctrl-C
 * membersihkan composer, berikutnya mempersenjatai "press again to exit", yang ketiga keluar —
 * dengan composer kosong yang kedua sudah keluar. Jumlah tetap ini keluar dengan ATAU tanpa draft.
 */
const CTRL_C_QUITS: Record<string, number> = { claude: 3 }

const CTRL_C = '\x03'

/** Jeda antar Ctrl-C berurutan: window "press again to quit" perlu melihat tekan yang terpisah. */
export const CTRL_C_GAP_MS = 150

/**
 * Perintah exit sebuah agent, atau null bila tidak ada cara aman meminta CLI-nya keluar.
 * Di-resolve lewat BASE harness supaya agent custom yang mewarisi claude keluar dengan `/exit`
 * claude — grammar CLI-nya memang grammar claude.
 */
export function exitSequence(agentId: AgentId | undefined): string | null {
  if (!agentId) return null
  return EXIT_SEQUENCES[capabilityAgentId(agentId)] ?? null
}

export type IneligibleReason = 'working' | 'no-session' | 'not-resumable'

/**
 * State yang panenya harus dibiarkan. `blocked` ada di sini dengan alasan yang lebih tajam
 * daripada kesopanan: ia berarti dialog permission/pertanyaan sedang MEMEGANG prompt, jadi menulis
 * baris exit berarti mengetikkannya SEBAGAI JAWABAN dialog itu alih-alih menutup CLI. Keduanya melaporkan alasan `'working'`: bagi
 * pengguna keduanya sama-sama "sedang sibuk, coba lagi sebentar".
 */
const BUSY_STATES: readonly AgentStatus[] = ['working', 'blocked']

/**
 * Gerbang tunggal yang dipakai context menu dan koreografi restart itu sendiri.
 *
 * `not-resumable` menang atas dua lainnya: CLI yang tidak bisa kita minta keluar atau tidak bisa
 * di-resume tidak akan pernah bisa di-restart, jadi tak ada yang bisa diperbaiki pengguna dengan
 * menunggu.
 */
export function restartEligibility(
  agentId: AgentId | undefined,
  state: AgentStatus | undefined,
  sessionId: string | undefined
): { ok: true } | { ok: false; reason: IneligibleReason } {
  if (!agentId || !canResume(agentId) || !exitSequence(agentId))
    return { ok: false, reason: 'not-resumable' }
  // Keluar di tengah turn akan menelantarkan pekerjaan yang sedang berjalan; keluar dari sesi
  // blocked akan menjawab dialognya dengan perintah exit (lihat BUSY_STATES).
  if (BUSY_STATES.includes(state as AgentStatus)) return { ok: false, reason: 'working' }
  // Tanpa session id provider tidak ada apa pun untuk di-resume.
  if (!sessionId || !isSafeSessionId(sessionId)) return { ok: false, reason: 'no-session' }
  return { ok: true }
}

/** Kalimat yang bisa ditampilkan untuk sebuah penolakan — apa yang harus ditunggu pengguna. */
export function ineligibleHint(reason: IneligibleReason): string {
  switch (reason) {
    case 'working':
      return 'This session is busy — restart after the turn (or permission prompt) finishes.'
    case 'no-session':
      return 'Nothing to resume yet — this session has not reported an id.'
    case 'not-resumable':
      return 'This CLI can’t be asked to exit and resume.'
  }
}

/** Satu write dalam urutan exit. `gapAfterMs` adalah jeda SETELAH write ini, sebelum yang berikut. */
export interface ExitWrite {
  data: string
  gapAfterMs: number
}

/**
 * Urutan write yang meminta sebuah agent keluar, atau null bila agent-nya tidak bisa diminta keluar.
 * Ctrl-C berulang. TIDAK ada Ctrl-U di depan: Ctrl-C sudah membersihkan
 * seluruh composer, dan tidak ada CR yang dikirim sehingga draft tidak pernah ikut terkirim.
 */
export function exitWrites(agentId: AgentId | undefined): ExitWrite[] | null {
  const exit = exitSequence(agentId)
  if (!exit || !agentId) return null
  const ctrlCs = CTRL_C_QUITS[capabilityAgentId(agentId)] ?? 0
  if (ctrlCs === 0) return null
  return Array.from({ length: ctrlCs }, (_, i) => ({
    data: CTRL_C,
    gapAfterMs: i === ctrlCs - 1 ? 0 : CTRL_C_GAP_MS,
  }))
}

/**
 * Berapa lama menunggu CLI melepaskan PTY setelah urutan exit dikirim, sebelum relaunch dipaksakan.
 *
 * ponytail: jendela tetap, bukan verifikasi. alternatifnya meng-poll `pane_current_command` tmux sampai
 * pane-nya kembali jadi shell; webterm tidak punya pane untuk ditanya (agent-nya ADALAH proses
 * PTY-nya, lihat header modul). Plafonnya: CLI yang keluar lebih lambat dari ini akan di-kill
 * sebelum sempat keluar sendiri, dan `--resume` lalu memulihkan percakapan dari transcript di disk
 * — kehilangan paling banyak pesan terakhir. Upgrade: begitu jalur PTY melaporkan perintah
 * foreground (atau meluncurkan agent DI DALAM shell interaktif, bukan `-c`), ganti dengan poll.
 */
export const EXIT_SETTLE_MS = 2500

/** Total durasi urutan exit, dipakai koreografi untuk menjadwalkan fase relaunch-nya. */
export function exitDurationMs(writes: ExitWrite[]): number {
  return writes.reduce((sum, w) => sum + w.gapAfterMs, 0)
}

/**
 * Kirim urutan exit sebuah agent lewat `write`, menghormati jeda antar write. Resolve setelah write
 * terakhir — pemanggil yang menunggu CLI benar-benar melepaskan PTY (lihat EXIT_SETTLE_MS).
 *
 * Melempar bila agent-nya tidak bisa diminta keluar, bukan diam-diam tidak melakukan apa pun:
 * pemanggil menggerbangi lewat `restartEligibility` lebih dulu, jadi sampai di sini artinya ada
 * bug penyambungan, bukan pilihan pengguna.
 */
export async function sendExitSequence(
  agentId: AgentId | undefined,
  write: (data: string) => void,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))
): Promise<void> {
  const writes = exitWrites(agentId)
  if (!writes) throw new Error(`sendExitSequence: agent '${agentId ?? '(none)'}' has no exit sequence`)
  for (const w of writes) {
    write(w.data)
    if (w.gapAfterMs > 0) await sleep(w.gapAfterMs)
  }
}
