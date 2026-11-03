// ---------------------------------------------------------------------------------------------
// Validasi session id.
//
// Session id DIINTERPOLASIKAN ke baris perintah shell (`--resume <id>`), jadi setiap titik
// interpolasi memvalidasi ulang terhadap alfabet ini — bukan percaya tipe. Alfabet: alfanumerik di
// depan, lalu `[A-Za-z0-9._-]`. Mencakup setiap id yang dicetak CLI agent (UUID, thread id
// codex/grok) dan menolak nilai mirip-flag (`-x`), berawalan titik, atau bermuatan metakarakter.
export const SESSION_ID_MAX = 256
/** Bentuk terbatas panjang — untuk pemeriksaan di batas input (intent peluncuran, seed identitas). */
export const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/
/** Tanpa batas panjang — dipakai helper resume/minted-id, supaya id panjang yang hari ini berfungsi
 *  tidak diam-diam berhenti bisa di-resume. */
export const SAFE_SESSION_ID_UNBOUNDED = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** Apakah `s` session id yang aman diinterpolasikan ke baris perintah? `bounded` memberlakukan
 *  `SESSION_ID_MAX` (pakai di batas input; helper resume memanggilnya tanpa batas). */
export function isSafeSessionId(s: unknown, bounded = false): boolean {
  if (typeof s !== 'string') return false
  const sid = s.trim()
  if (!sid) return false
  return (bounded ? SAFE_SESSION_ID : SAFE_SESSION_ID_UNBOUNDED).test(sid)
}

// ---------------------------------------------------------------------------------------------
// Validasi node id.
//
// Node id datang dari client lewat WebSocket dan DIDARATKAN di dua tempat yang mengeksekusi teks:
// baris perintah curl hook claude (`claudeHooksSettings`, src/server/hooks.ts) dan kunci PTY/status.
// Alfabetnya sengaja lebih sempit dari session id: alfanumerik, `_`, `-`, dan `:` — UUID
// `randomId()` muat, dan begitu pula id pane split `${nodeId}:p${n}` dari client/paneTree.ts
// (tanpa `:` setiap pane hasil split ditolak dan tidak pernah mendapat PTY). Karakter pertama WAJIB
// alfanumerik supaya nilai mirip-flag (`-x`, `--help`) ditolak, bukan diteruskan ke shell. Kutip,
// `$`, `;`, spasi, newline, `/`, dan `.` tetap tidak muat. Maksimum 64 karakter.
export const NODE_ID_MAX = 64
export const SAFE_NODE_ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,63}$/

/** Apakah `id` node id yang aman dipakai sebagai kunci sesi DAN diinterpolasikan ke perintah shell?
 *  Dipanggil di batas WebSocket (`Sessions.open`) dan lagi di titik interpolasi (hooks.ts), bukan
 *  dipercaya dari tipe. Menerima id pane split `${nodeId}:p${n}` selama totalnya <= `NODE_ID_MAX`
 *  dan karakter pertamanya alfanumerik (jadi `-x`/`--help` ditolak). */
export const isSafeNodeId = (id: unknown): id is string =>
  typeof id === 'string' && SAFE_NODE_ID.test(id)
