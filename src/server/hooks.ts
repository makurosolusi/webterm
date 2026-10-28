import { randomUUID, timingSafeEqual } from 'node:crypto'
import { isPermissionMode, type AgentPermissionMode, type AgentStatus } from '../shared/workspace'

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
 *  - `SubagentStart`/`SubagentStop` adalah siklus hidup subagent claude sendiri; keduanya menjaga
 *    node induk tetap terbaca "working" selama anak berjalan.
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
// Pemetaan event → status.

/**
 * Memetakan stdin JSON sebuah hook claude ke status live. null = event yang kita abaikan.
 *
 * TIDAK ADA sniff regex pada `Notification`: `PermissionRequest` adalah event yang sebenarnya
 * untuk "sedang menunggu izin", dan mencocokkan kata di pesan `Notification` adalah heuristik yang
 * salah ke dua arah (nudge idle yang menyebut kata "approve" terbaca blocked; prompt permission
 * dalam bahasa lain tidak terbaca sama sekali).
 */
export function hookStatus(body: { hook_event_name?: string }): AgentStatus | null {
  switch (body.hook_event_name) {
    case 'SessionStart':
    case 'UserPromptSubmit':
    case 'PreToolUse':
    case 'PostToolUse':
    // Anak mulai/berhenti; induknya masih di tengah turn.
    case 'SubagentStart':
    case 'SubagentStop':
      return 'working'
    case 'Stop':
    // CATATAN BEDA DARI NODETERM: nodeterm punya state `errored` tersendiri untuk ini. `AgentStatus`
    // webterm hanya punya empat nilai, jadi turn yang gagal mendarat di `waiting` — benar dalam hal
    // "turn-nya sudah berakhir, giliranmu", kurang dalam hal "ia berakhir karena error". Upgrade:
    // tambahkan 'errored' ke AgentStatus di src/shared/workspace.ts bila ada permukaan yang merendernya.
    case 'StopFailure':
    // Nudge idle. Prompt permission datang sebagai PermissionRequest, bukan di sini.
    case 'Notification':
      return 'waiting'
    case 'PermissionRequest':
      return 'blocked'
    case 'SessionEnd':
      return 'done'
    default:
      return null
  }
}

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

/** Token node, dicetak saat pertama diminta. Satu token per node, stabil selama proses berjalan. */
export function nodeToken(nodeId: string): string {
  let t = tokens.get(nodeId)
  if (!t) {
    t = randomUUID()
    tokens.set(nodeId, t)
  }
  return t
}

/** Lupakan token sebuah node (node dihapus / sesi ditutup). */
export function forgetNodeToken(nodeId: string): void {
  tokens.delete(nodeId)
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
 * Objek `--settings` inline: satu curl catch-all per event, mem-POST stdin hook ke endpoint
 * agent-status kita dengan key node id. Dikembalikan sebagai OBJEK supaya test bisa meng-assert
 * strukturnya tanpa mem-parse quoting shell.
 *
 * Token node dikirim lewat `$NODETERM_NODE_TOKEN` — REFERENSI env var, bukan nilainya. Nilainya
 * tidak boleh mendarat di baris perintah: di sana ia terbaca semua proses pengguna lewat `ps`.
 * Tanda `$` bertahan melewati single-quote baris peluncuran dan di-expand oleh shell yang
 * menjalankan hook, yang mewarisi env sesi agent (lihat `hookEnv`).
 */
export function claudeHooksSettings(nodeId: string, port: number): Record<string, unknown> {
  const cmd =
    `curl -s 'http://127.0.0.1:${port}/api/agent-status?node=${nodeId}' ` +
    `-H "${NODE_TOKEN_HEADER}: $${NODE_TOKEN_ENV}" --data-binary @- >/dev/null 2>&1 || true`
  const hooks: Record<string, unknown[]> = {}
  for (const e of CLAUDE_HOOK_EVENTS) {
    const timeout = typeof e === 'string' ? undefined : e.timeout
    hooks[hookEventName(e)] = [
      { matcher: '', hooks: [{ type: 'command', command: cmd, ...(timeout !== undefined ? { timeout } : {}) }] },
    ]
  }
  return { hooks }
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
  opts?: { permissionMode?: AgentPermissionMode }
): string {
  const idFlag = resume ? `--resume ${sessionId}` : `--session-id ${sessionId}`
  const perm = permissionModeFlag(opts?.permissionMode)
  return [idFlag, perm, `--settings ${shq(JSON.stringify(claudeHooksSettings(nodeId, port)))}`]
    .filter(Boolean)
    .join(' ')
}
