/**
 * Pertanyaan terakhir sebelum sebuah node agent diluncurkan dengan `claude --resume <id>`: apakah
 * percakapan itu masih ADA?
 *
 * ## Gejala yang dibunuh modul ini
 *
 * Node agent claude mati seketika di peluncuran dengan
 *
 *     No conversation found with session ID: <uuid>
 *     exit status 1
 *     [process exited]
 *
 * dan node-nya jatuh ke shell kosong. Sudah terjadi berkali-kali ke pengguna.
 *
 * Akarnya: `msg.resume` yang dikirim client hanya berarti "node ini punya sessionId tersimpan". Itu
 * BUKAN bukti transcript-nya masih di disk. Transcript bisa hilang karena pembersihan 30 hari milik
 * claude, node ditutup sebelum CLI sempat menulis apa pun, `/clear` yang mencetak id baru di dalam
 * CLI, atau id yang webterm cetak untuk sesi yang tidak pernah benar-benar jalan. Begitu id-nya
 * mati, CLI mencetak baris di atas lalu keluar — dan tidak ada yang menyadarinya: node tetap
 * memakai badge agent-nya, terminalnya terlihat idle, satu-satunya bukti satu baris scrollback.
 *
 * Bukti lapangan terukur: pada host pelapor, 20 pane duduk di shell kosong
 * dengan persis baris itu, dan tidak satu pun dari 20 session id tadi punya `<id>.jsonl` di mana
 * pun di bawah root transcript.
 *
 * ## Aturannya: tiga keadaan, dan hanya `absent` yang menjatuhkan resume
 *
 * `unknown` (root tak terbaca, direktori tak ada, agent bukan claude, session id tak sah) tetap
 * resume PERSIS seperti sebelum modul ini ada. Itu bukan kehati-hatian demi kehati-hatian — biaya
 * kedua kesalahannya asimetris jauh:
 *
 * - Salah me-resume id mati = satu baris jelek + shell kosong. Jelek, tapi bisa dipulihkan.
 * - Salah MENJATUHKAN id yang masih hidup = diam-diam memulai percakapan kosong dan menelantarkan
 *   kerja yang pengguna kira sedang dilanjutkan, sementara aslinya masih di disk dan tidak ada apa
 *   pun di layar yang menunjuk ke sana.
 *
 * Jadi defaultnya selalu "tetap resume kecuali benar-benar TERBUKTI tidak ada".
 *
 * ## Kenapa gerbangnya kapabilitas, bukan nama agent
 *
 * Probe ini mencari `<id>.jsonl` berbentuk claude di bawah config dir claude. Session id codex,
 * gemini, cursor atau copilot meleset dari resolver itu MENURUT KONSTRUKSI — setiap kali — jadi
 * menanyakannya akan menjawab `absent` untuk sesi yang sehat dan menjatuhkan resume-nya. Gerbangnya
 * `hasClaudeHookSettings`, daftar kapabilitas yang sama yang dipakai `launchLine` untuk memilih
 * cabang claude; agent lain mempertahankan perilaku hari ini tanpa perubahan sampai ada yang
 * mengajari probe ini layout mereka.
 *
 * ## Kenapa memindai semua project dir, bukan menghitung slug dari cwd
 *
 * Slug direktori claude (`~/.claude/projects/<slug-cwd>`) adalah detail internal yang bisa berubah,
 * dan cwd sebuah sesi bisa berbeda dari cwd node-nya (pengguna `cd`, atau node dibuat di tempat
 * lain). Karena itu pencarian memakai glob lintas project dir.
 *
 * ## Keputusan disengaja: launch dengan id baru saat `absent`
 *
 * Saat `absent`, alternatifnya meluncurkan agent POLOS (tanpa flag id sama sekali). Kita TIDAK: kita
 * meluncurkan dengan `--session-id <sid>`, yaitu cukup membalik `resume` menjadi `false` dan
 * memakai jalur yang sudah ada. Kenapa boleh dan kenapa lebih baik:
 *
 * - Bila id-nya bisa berasal dari sesi yang bukan kita yang meluncurkan, memakai ulang id itu
 *   berarti mengarang. Di sini `sessionId` SELALU dicetak webterm sendiri
 *   (`src/client/AgentNode.tsx` mencetak dan mem-persist-nya), jadi id itu milik kita.
 * - Registry claude praktis adalah berkas `<id>.jsonl` itu sendiri. Di cabang ini probe baru saja
 *   membuktikan tidak ada satu pun di seluruh root, jadi `--session-id <sid>` tidak akan kena
 *   "Session ID … is already in use."
 * - Ia mempertahankan rantai resume node: id-nya tetap sama, jadi percakapan berikutnya tersimpan
 *   di bawah id yang SUDAH di-persist node itu. Meluncur polos membuat claude mencetak id sendiri
 *   yang tidak pernah diketahui webterm, dan node itu jadi tak bisa di-resume selamanya.
 */
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { hasClaudeHookSettings, isSafeSessionId } from '../shared/workspace'

export type TranscriptPresence = 'present' | 'absent' | 'unknown'

/** Root transcript claude. `CLAUDE_CONFIG_DIR` adalah override resmi claude untuk config dir-nya,
 *  jadi ia menang; tanpa itu `~/.claude`. */
export function claudeProjectsRoot(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR?.trim()
  return join(configDir || join(homedir(), '.claude'), 'projects')
}

/**
 * Apakah ada `<sessionId>.jsonl` di bawah salah satu project dir? `root` bisa di-inject supaya test
 * tidak pernah menyentuh home pengguna.
 */
export function probeTranscript(
  sessionId: string | undefined,
  root: string = claudeProjectsRoot()
): TranscriptPresence {
  const sid = sessionId?.trim()
  // Session id ini membentuk PATH, dan datang lewat WebSocket — jadi divalidasi ulang di sini,
  // batas input. Id tak sah bukan "tidak ada transcript", ia "kita tidak bisa bertanya".
  if (!sid || !isSafeSessionId(sid, true)) return 'unknown'
  const leaf = `${sid}.jsonl`
  try {
    const dirs = readdirSync(root)
    for (const dir of dirs) {
      if (existsSync(join(root, dir, leaf))) return 'present'
    }
    // Root TERBACA dan tidak ada yang cocok: ini satu-satunya jawaban yang menjatuhkan resume.
    return 'absent'
  } catch {
    // Sengaja TIDAK di-swallow jadi `absent`: root tidak ada / tidak terbaca / bukan direktori
    // berarti kita tidak tahu apa-apa, dan "tidak tahu" harus tetap resume (lihat asimetri di atas).
    return 'unknown'
  }
}

/** Aturan keputusannya, murni, supaya bisa di-assert tanpa filesystem: hanya `absent` yang menang. */
export function dropsResume(presence: TranscriptPresence): boolean {
  return presence === 'absent'
}

/** Gerbang agent + probe + aturan, dalam satu panggilan untuk `sessions.open()`. */
export function resumeIsDead(
  sessionId: string | undefined,
  agentId: string | undefined,
  root?: string
): boolean {
  if (!agentId || !hasClaudeHookSettings(agentId)) return false
  return dropsResume(probeTranscript(sessionId, root))
}

/** Catatan yang terlihat pengguna, gaya `wrapperMissingNotice` di sessions.ts. Session id TIDAK
 *  pernah dicetak — ia identitas sesi, bukan informasi yang menolong pengguna di sini. */
export const transcriptMissingNotice =
  '\r\n[webterm] no saved conversation for this session — starting a fresh one.\r\n'
