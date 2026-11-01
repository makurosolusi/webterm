import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isPermissionMode, type AgentPermissionMode } from '../shared/workspace'
import { TOKEN_HEADER } from './auth'
import { dataDir } from './config'
import { forgetHookContext } from './hookContext'

// ---------------------------------------------------------------------------------------------
// Langganan event hook.

/** Satu langganan hook terkelola: nama event, atau nama event PLUS `timeout` handler-nya. */
export type HookSubscription = string | { event: string; timeout: number }

/** Nama event sebuah langganan, dalam bentuk apa pun ia dideklarasikan. */
export const hookEventName = (e: HookSubscription): string => (typeof e === 'string' ? e : e.event)

/**
 * `timeout` (detik) yang kita tulis pada handler `PermissionRequest` claude. Default command-hook
 * claude hari ini juga 600 detik, tapi hook yang MENAHAN request menunggu Approve/Deny dari canvas
 * menunggu sampai `PERM_WAIT_SECS_INTERACTIVE` — jadi batas yang menjadi ukuran penahanan itu kita
 * tuliskan sendiri alih-alih meminjam default CLI yang bisa berubah di bawah kita.
 */
export const PERMISSION_REQUEST_HOOK_TIMEOUT_SECS = 600

/**
 * Berapa lama hook permission menahan sebuah request menunggu Approve/Deny dari canvas sebelum
 * jatuh ke prompt interaktif claude biasa. 60 detik di bawah `PERMISSION_REQUEST_HOOK_TIMEOUT_SECS`
 * supaya hook selalu keluar dengan caranya sendiri, bukan dibunuh timeout.
 */
export const PERM_WAIT_SECS_INTERACTIVE = 540

/**
 * Event hook Claude Code yang kita langgani. Sebelas, sama dengan `CLAUDE_HOOK_EVENTS` nodeterm
 * (`src/shared/agents/hook-events.ts`) — diverifikasi terhadap v0.4.5.
 *
 * Yang dulu hilang di webterm dan kenapa penting:
 *  - `StopFailure` menyala MENGGANTIKAN `Stop` saat sebuah turn berakhir karena error API/model.
 *    Tanpa itu badge status tersangkut di "working" setelah setiap turn yang gagal.
 *  - `PermissionRequest` adalah sinyal prompt-permission yang SEBENARNYA. Ia membawa `timeout`
 *    eksplisit karena hook terkelola menahannya (lihat PERM_WAIT_SECS_INTERACTIVE).
 *  - `SubagentStart`/`SubagentStop` adalah siklus hidup subagent claude sendiri. Keduanya TIDAK
 *    memetakan ke status node (lihat `hookStatus`); dilanggani karena POST-nya tetap membawa
 *    `transcript_path` yang dipanen `setTranscript` untuk konteks-tertaut.
 *
 * `SessionStart` TETAP dilanggani meski tidak lagi memetakan ke status apa pun (lihat `hookStatus`):
 * ia hook PERTAMA yang menyala, jadi ia yang memasok `transcript_path` ke `setTranscript`
 * (`api.ts`) — tanpa itu konteks-tertaut buta sampai prompt pertama dikirim.
 */
export const CLAUDE_HOOK_EVENTS: readonly HookSubscription[] = [
  'SessionStart',
  'UserPromptSubmit',
  'Stop',
  'StopFailure',
  'Notification',
  { event: 'PermissionRequest', timeout: PERMISSION_REQUEST_HOOK_TIMEOUT_SECS },
  'SessionEnd',
  'PreToolUse',
  'PostToolUse',
  'SubagentStart',
  'SubagentStop',
]

// ---------------------------------------------------------------------------------------------
// Token auth per-node.

/**
 * Header yang membawa token node sebuah hook. JANGAN di-rename: ia wire-protocol yang kompatibel
 * dengan nodeterm upstream.
 */
export const NODE_TOKEN_HEADER = 'x-nodeterm-node-token'

/** Nama env var tempat sesi agent menemukan token node-nya. Juga wire-protocol — jangan di-rename. */
export const NODE_TOKEN_ENV = 'NODETERM_NODE_TOKEN'

const tokens = new Map<string, string>()

/**
 * Kebalikan `tokens`: token → node id.
 *
 * Dipakai jalur transport untuk menjawab "token ini milik node MANA" dalam O(1). Sebelumnya satu-
 * satunya cara adalah memindai `tokens.values()`, yang hanya bisa menjawab "sah atau tidak" — dan
 * jawaban itulah lubangnya: token node A yang sah bisa dipakai untuk menulis status node B hanya
 * dengan mengganti `?node=`.
 */
const tokenOwners = new Map<string, string>()

/** Token node, dicetak saat pertama diminta. Satu token per node, stabil selama proses berjalan. */
export function nodeToken(nodeId: string): string {
  let t = tokens.get(nodeId)
  if (!t) {
    t = randomUUID()
    tokens.set(nodeId, t)
    tokenOwners.set(t, nodeId)
  }
  return t
}

/** Lupakan segala jejak sebuah node: token DAN file settings/header-nya (node dihapus / sesi ditutup). */
export function forgetNodeToken(nodeId: string): void {
  const t = tokens.get(nodeId)
  // Ikatan token→node dibuang SEBELUM tokennya: token yang sudah dilupakan tidak boleh lagi
  // membuktikan identitas node mana pun (kalau tidak, ia jadi kunci bebas ke seluruh registry).
  if (t !== undefined) tokenOwners.delete(t)
  tokens.delete(nodeId)
  // Memo pengumuman roster hidup per node di memori: tanpa disapu di sini Map-nya tumbuh selamanya,
  // dan id yang dipakai ulang mewarisi dedup milik node yang sudah mati.
  forgetHookContext(nodeId)
  // Best-effort: file yatim tidak membahayakan apa pun, tapi gagal menghapusnya tidak boleh
  // menggagalkan penutupan sesi.
  try {
    rmSync(claudeSettingsPath(nodeId), { force: true })
  } catch {
    /* ignore */
  }
  try {
    rmSync(claudeHeadersPath(nodeId), { force: true })
  } catch {
    /* ignore */
  }
}

/**
 * Apakah sebuah nilai adalah token node yang PERNAH dicetak proses ini?
 *
 * Dipakai jalur transport (lihat `authorizeRequest` di auth.ts): anak PTY hanya membawa token
 * node-nya sendiri, bukan root `WEBTERM_TOKEN`, jadi permintaan hook bisa tetap lolos gerbang
 * `/api/` tanpa membagikan token root ke setiap sesi agent. Nilai token adalah UUID acak, jadi
 * pencarian map biasa cukup — perbandingan waktu-konstan tidak diperlukan (tidak ada prefix
 * rahasia yang bisa ditebak bertahap).
 */
export function isValidNodeToken(token: string): boolean {
  return nodeIdForToken(token) !== undefined
}

/**
 * Node pemilik sebuah token node, atau `undefined` bila token itu bukan token node yang pernah
 * dicetak proses ini (root token, token asing, string kosong).
 *
 * Ini jawaban yang dibutuhkan otorisasi per-node: `isValidNodeToken` hanya bilang "sah", padahal
 * yang menentukan boleh-tidaknya sebuah request menulis node tertentu adalah "sah UNTUK node mana".
 */
export function nodeIdForToken(token: string): string | undefined {
  if (typeof token !== 'string' || token === '') return undefined
  return tokenOwners.get(token)
}

/**
 * Apakah request hook ini membuktikan identitasnya? Endpoint hook sengaja FAIL-OPEN — sebuah hook
 * tanpa token tetap memperbarui status, karena sesi yang diluncurkan sebelum token ada (atau oleh
 * jalur lain) tidak boleh kehilangan badge-nya. Yang dibawa nilai balik ini adalah apakah status
 * itu TERBUKTI berasal dari node yang mengaku, sehingga konsumen yang butuh bukti identitas bisa
 * membedakan — bukan gerbang terima/tolak.
 */
export function stateVerified(nodeId: string, header: string | string[] | undefined): boolean {
  const got = Array.isArray(header) ? header[0] : header
  const want = tokens.get(nodeId)
  if (!want || typeof got !== 'string') return false
  const a = Buffer.from(got)
  const b = Buffer.from(want)
  // Panjang beda sudah membocorkan ketidakcocokan lewat `timingSafeEqual` yang melempar, jadi
  // dibandingkan lebih dulu; sisanya waktu-konstan.
  return a.length === b.length && timingSafeEqual(a, b)
}

// ---------------------------------------------------------------------------------------------
// Perakitan baris peluncuran.

/**
 * Encode sebuah nilai untuk query string, LEBIH KETAT dari `encodeURIComponent`.
 *
 * `encodeURIComponent` sengaja membiarkan `'`, `(`, `)`, `!`, `*` mentah. Untuk sebuah nilai yang
 * juga dilarutkan ke baris shell, `'` mentah berarti quoting URL bergantung sepenuhnya pada `shq` —
 * benar hari ini, tapi satu lapis saja. Di sini `'` (dan kawan-kawannya) dipersenkan sendiri,
 * sehingga URL-nya aman dibaca siapa pun, bahkan sebelum masuk shell.
 */
const encodeQueryValue = (v: string): string =>
  encodeURIComponent(v).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)

/**
 * Isi file `--settings`: satu curl catch-all per event, mem-POST stdin hook ke endpoint
 * agent-status kita dengan key node id. Dikembalikan sebagai OBJEK supaya test bisa meng-assert
 * strukturnya tanpa mem-parse quoting shell.
 *
 * Token TIDAK PERNAH muncul di baris perintah, tidak sebagai nilai dan tidak sebagai ekspansi.
 * `curl` menerima `-H @<file>`: header (dan nilainya) dibaca dari sebuah file 0600 milik pengguna
 * (`claudeHeadersPath`), yang ditulis `writeClaudeSettings` tepat sebelum sesi diluncurkan. Dulu
 * baris ini berbunyi `-H "x-nodeterm-node-token: $NODETERM_NODE_TOKEN"`; shell meng-expand kedua
 * variabel SEBELUM `exec`, jadi token aslinya tetap mendarat di argv curl dan terbaca semua proses
 * pengguna lewat `ps`. Referensi env var hanya menyembunyikan nilainya dari teks settings, bukan
 * dari argv proses yang benar-benar berjalan.
 *
 * DUA header, bukan satu. `x-nodeterm-node-token` adalah identitas per-node (dibaca
 * `stateVerified`); `x-webterm-token` adalah token TRANSPORT yang menggerbangi seluruh `/api/`
 * (`authorizeRequest` di auth.ts) — tanpanya setiap POST hook dibalas 403 begitu token diset,
 * yang mematikan badge status DAN registrasi transcript (sumber data context-link).
 *
 * Keduanya memakai token NODE, bukan root `WEBTERM_TOKEN`. Node token hanya membuka
 * `/api/agent-status`, `/api/context-link`, dan `/api/control/*`, jadi bocornya file header tidak
 * memberi akses ke settings/workspace. Root token tidak pernah menyentuh disk.
 *
 * STDOUT DIBIARKAN HIDUP (`>/dev/null` dilepas): stdout hook adalah satu-satunya kanal yang Claude
 * Code sendiri buka untuk MENDORONG teks ke konteks agent (`hookSpecificOutput.additionalContext`
 * pada `SessionStart`/`UserPromptSubmit`) — dibuang, dan agent tak pernah tahu node tetangganya ada
 * sampai ia kebetulan memanggil skill-nya. Maka stderr dibungkam SENDIRI (`2>/dev/null`), tak lagi
 * digabung (`2>&1`): di stdout, pesan gagal-konek/DNS/timeout curl jadi sampah di konteks agent.
 * `|| true` tetap — hook yang gagal tidak boleh menggagalkan turn agent.
 */
export function claudeHooksSettings(nodeId: string, port: number): Record<string, unknown> {
  // Node id DIDARATKAN ke baris shell dan ke query string. Dua lapis, bukan satu:
  //  1. `encodeQueryValue` supaya id tidak bisa menutup argumen query atau menyelundupkan
  //     `&header=…` ke URL (id aman hari ini lewat `isSafeNodeId`; ini lapis kedua yang tetap
  //     benar kalau alfabetnya suatu saat dilebarkan), termasuk `'` yang `encodeURIComponent`
  //     biarkan mentah.
  //  2. `shq` — SELURUH URL jadi satu argumen single-quoted, jadi tidak ada metakarakter id yang
  //     bisa dibaca shell, dan `$` di dalamnya juga tidak di-expand.
  // Validasi (`isSafeNodeId`) tetap dilakukan di batas WebSocket; di sini pertahanannya quoting,
  // karena fungsi ini juga dipanggil dari test dan jalur lain.
  const url = `http://127.0.0.1:${port}/api/agent-status?node=${encodeQueryValue(nodeId)}`
  const cmd =
    `curl -s ${shq(url)} -H @${shq(claudeHeadersPath(nodeId))} ` +
    `--data-binary @- 2>/dev/null || true`
  const hooks: Record<string, unknown[]> = {}
  for (const e of CLAUDE_HOOK_EVENTS) {
    const timeout = typeof e === 'string' ? undefined : e.timeout
    hooks[hookEventName(e)] = [
      { matcher: '', hooks: [{ type: 'command', command: cmd, ...(timeout !== undefined ? { timeout } : {}) }] },
    ]
  }
  return { hooks }
}

/**
 * Nama file di-hash, bukan `nodeId` mentah: id itu datang dari client lewat WebSocket dan tidak
 * pernah divalidasi sebagai nama file, jadi memakainya langsung adalah path traversal.
 */
function claudeSettingsPath(nodeId: string): string {
  const name = createHash('sha256').update(nodeId).digest('hex').slice(0, 16)
  return join(dataDir(), 'node-settings', `${name}.json`)
}

/**
 * Tulis settings hook node ini ke file dan kembalikan path-nya.
 *
 * Lewat FILE, bukan blob JSON inline: baris peluncuran bisa dibungkus perintah pihak ketiga
 * (`envman -e p:e -- claude`), dan pembungkus seperti itu memindai argumennya sendiri — URL callback
 * `http://127.0.0.1:...` di dalam blob terbaca sebagai referensi `slug:path` miliknya, yang membuat
 * peluncuran mati sebelum claude jalan. Sebuah path tidak memuat `:` sama sekali.
 *
 * Mode 0600: isinya tidak lagi memuat token (header dibaca curl dari file terpisah), tapi file ini
 * mengarahkan ke mana sebuah sesi agent mem-POST — bukan sesuatu yang perlu bisa ditulis pengguna
 * lain.
 */
export function writeClaudeSettings(nodeId: string, port: number): string {
  const path = claudeSettingsPath(nodeId)
  ensureNodeSettingsDir()
  // Ditulis SEBELUM settings dikembalikan: baris hook menunjuk ke file ini, dan sesi agent bisa
  // langsung menjalankan hook pertamanya begitu claude hidup.
  writeClaudeHeaders(nodeId)
  writeFileSync(path, JSON.stringify(claudeHooksSettings(nodeId, port)), { mode: 0o600 })
  return path
}

/** Direktori bersama file settings + file header. 0700: ia kini memuat token hidup. */
function ensureNodeSettingsDir(): string {
  const dir = join(dataDir(), 'node-settings')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  // `recursive` tidak menyempitkan direktori yang sudah ada dari versi sebelumnya, jadi mode-nya
  // dipersempit eksplisit. Dilewati di Windows, yang tidak punya mode POSIX.
  if (process.platform !== 'win32') chmodSync(dir, 0o700)
  return dir
}

/**
 * File header yang dibaca `curl -H @file` (0600). Nilai token hidup DI SINI, bukan di argv.
 *
 * Ditulis ulang setiap peluncuran supaya token node yang baru (proses restarted) ikut. Setelah
 * ada, file ini hanya bisa dibaca pemiliknya.
 */
function writeClaudeHeaders(nodeId: string): string {
  const path = claudeHeadersPath(nodeId)
  const token = nodeToken(nodeId)
  const lines = [`${NODE_TOKEN_HEADER}: ${token}`, `${TOKEN_HEADER}: ${token}`]
  // `mode` 0600 berlaku saat file dibuat; berkas ini tidak pernah ada sebelum perubahan ini, dan
  // penulisan ulang mempertahankan modenya.
  writeFileSync(path, `${lines.join('\n')}\n`, { mode: 0o600 })
  return path
}

/** Nama file di-hash dengan alasan yang sama seperti `claudeSettingsPath`. */
function claudeHeadersPath(nodeId: string): string {
  const name = createHash('sha256').update(nodeId).digest('hex').slice(0, 16)
  return join(dataDir(), 'node-settings', `${name}.headers`)
}

/** Single-quote sebuah string untuk shell POSIX (tutup-escape-buka untuk quote di dalamnya). */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/**
 * Env var yang harus dibawa sebuah sesi agent. DIKEMBALIKAN, bukan ditulis: pemanggil (jalur spawn
 * PTY) yang menggabungkannya ke env proses.
 *
 * `hookReplyApprovals` off ⇒ `NODETERM_PERM_WAIT_SECS` ABSEN ⇒ perilaku lama persis: hook permission
 * tidak menahan apa pun dan claude langsung menampilkan prompt interaktifnya.
 */
export function hookEnv(nodeId: string, opts?: { hookReplyApprovals?: boolean }): Record<string, string> {
  const waitSecs = opts?.hookReplyApprovals ? PERM_WAIT_SECS_INTERACTIVE : 0
  return {
    [NODE_TOKEN_ENV]: nodeToken(nodeId),
    ...(waitSecs > 0 ? { NODETERM_PERM_WAIT_SECS: String(waitSecs) } : {}),
  }
}

/**
 * Flag `--permission-mode` untuk sebuah mode. `manual` tidak menghasilkan flag, jadi perintahnya
 * tetap polos — persis perintah yang webterm kirim sebelum setting ini ada.
 *
 * Mode divalidasi ULANG di sini meski parameternya bertipe: `AgentPermissionMode` hanya janji
 * compile-time, sedangkan nilainya datang dari settings yang bisa diedit tangan / lewat HTTP
 * sebelum diinterpolasikan ke baris perintah shell.
 */
export function permissionModeFlag(mode: AgentPermissionMode | undefined): string {
  if (!isPermissionMode(mode) || mode === 'manual') return ''
  return `--permission-mode ${mode}`
}

/**
 * Flag yang ditempelkan ke baris peluncuran claude (TANPA spasi di depan; pemanggil menyambung
 * dengan satu spasi). resume=false → sesi baru lewat `--session-id`; resume=true → lanjut lewat
 * `--resume`.
 *
 * `permissionMode` MASUK sebagai parameter, tidak dibaca dari store settings di sini: modul ini
 * dipakai di jalur spawn dan di test, dan integrator yang tahu settings mana yang berlaku.
 */
export function buildClaudeFlags(
  nodeId: string,
  sessionId: string,
  port: number,
  resume: boolean,
  opts?: {
    permissionMode?: AgentPermissionMode
    /** Di-inject supaya test tetap bebas I/O (pola sama dengan `unwrapMissingWrapper` di pty.ts). */
    writeSettings?: (nodeId: string, port: number) => string
  }
): string {
  const idFlag = resume ? `--resume ${sessionId}` : `--session-id ${sessionId}`
  const perm = permissionModeFlag(opts?.permissionMode)
  const settings = (opts?.writeSettings ?? writeClaudeSettings)(nodeId, port)
  return [idFlag, perm, `--settings ${shq(settings)}`].filter(Boolean).join(' ')
}
