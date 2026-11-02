import { randomUUID, timingSafeEqual } from 'node:crypto'
import { rmSync } from 'node:fs'
import { forgetHookContext } from './hookContext'
import { claudeHeadersPath, claudeSettingsPath } from './hooksPaths'
import { firstHeader } from './httpHeaders'

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
  const got = firstHeader(header)
  const want = tokens.get(nodeId)
  if (!want || typeof got !== 'string') return false
  const a = Buffer.from(got)
  const b = Buffer.from(want)
  // Panjang beda sudah membocorkan ketidakcocokan lewat `timingSafeEqual` yang melempar, jadi
  // dibandingkan lebih dulu; sisanya waktu-konstan.
  return a.length === b.length && timingSafeEqual(a, b)
}
