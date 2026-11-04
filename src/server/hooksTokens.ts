import { randomUUID, timingSafeEqual } from 'node:crypto'
import { readFileSync, rmSync } from 'node:fs'
import { forgetHookContext } from './hookContext'
import { claudeHeadersPath, claudeSettingsPath } from './hooksPaths'
import { firstHeader } from './httpHeaders'
import { createLogger } from './logs'
import { activePolicy } from './policy/policy.runtime'

const log = createLogger('hooks')
const NODE_PRINCIPAL = 'node:'

/**
 * Header yang membawa token node sebuah hook. JANGAN di-rename: ia wire-protocol yang kompatibel
 * dengan nodeterm upstream.
 */
export const NODE_TOKEN_HEADER = 'x-nodeterm-node-token'

/** Nama env var tempat sesi agent menemukan token node-nya. Juga wire-protocol — jangan di-rename. */
export const NODE_TOKEN_ENV = 'NODETERM_NODE_TOKEN'

/** Re-export: the constant lives in `hooksPaths` (dependency-free, so the shims import it without a cycle). */
export { NODE_HEADERS_ENV } from './hooksPaths'

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

function remember(nodeId: string, token: string): void {
  tokens.set(nodeId, token)
  tokenOwners.set(token, nodeId)
}

/**
 * Token yang sudah ada di file header node itu sendiri, bila ledger masih mengakuinya untuk node ini.
 * Nilai mentah hanya hidup di file header (0600); ledger menyimpan sha256-nya (policy_token), jadi
 * restart + re-adopt supervisor menulis ulang file dengan token YANG SAMA, bukan mencetak baru.
 */
function persistedToken(nodeId: string): string | undefined {
  const policy = activePolicy()
  if (!policy) return undefined
  let text: string
  try {
    text = readFileSync(claudeHeadersPath(nodeId), 'utf8')
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code
    if (code !== 'ENOENT') log.warn('hooks.token.header_unreadable', 'Node header file unreadable; minting a new node token', { ids: { nodeId }, code })
    return undefined
  }
  const prefix = `${NODE_TOKEN_HEADER}: `
  const line = text.split('\n').find((l) => l.startsWith(prefix))
  const token = line?.slice(prefix.length).trim()
  return token && policy.store.verifyToken(token) === `${NODE_PRINCIPAL}${nodeId}` ? token : undefined
}

/** Token baru; dengan ledger, token lama node ini dicabut dulu supaya hanya satu yang hidup. */
function mintToken(nodeId: string): string {
  const store = activePolicy()?.store
  if (!store) return randomUUID()
  store.revokeTokensOf(`${NODE_PRINCIPAL}${nodeId}`)
  return store.issueToken(`${NODE_PRINCIPAL}${nodeId}`)
}

/**
 * Token node, dicetak saat pertama diminta. Satu token per node, stabil selama proses berjalan dan,
 * saat ledger aktif, LINTAS restart (sha256 di ledger, nilai di file header node). Tanpa ledger:
 * UUID in-memory seperti sebelumnya.
 */
export function nodeToken(nodeId: string): string {
  const known = tokens.get(nodeId)
  if (known) return known
  const t = persistedToken(nodeId) ?? mintToken(nodeId)
  remember(nodeId, t)
  return t
}

/** Lupakan segala jejak sebuah node: token DAN file settings/header-nya (node dihapus / sesi ditutup). */
export function forgetNodeToken(nodeId: string): void {
  const t = tokens.get(nodeId)
  // Ikatan token→node dibuang SEBELUM tokennya: token yang sudah dilupakan tidak boleh lagi
  // membuktikan identitas node mana pun (kalau tidak, ia jadi kunci bebas ke seluruh registry).
  if (t !== undefined) tokenOwners.delete(t)
  tokens.delete(nodeId)
  // Yang persisten ikut dicabut: token node yang dilupakan tidak boleh hidup lagi setelah restart.
  activePolicy()?.store.revokeTokensOf(`${NODE_PRINCIPAL}${nodeId}`)
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
  const owner = tokenOwners.get(token)
  if (owner !== undefined) return owner
  // Setelah restart map kosong; token yang dicetak proses sebelumnya dibuktikan lewat ledger.
  const principal = activePolicy()?.store.verifyToken(token)
  if (!principal?.startsWith(NODE_PRINCIPAL)) return undefined
  const nodeId = principal.slice(NODE_PRINCIPAL.length)
  if (tokens.get(nodeId) === undefined) remember(nodeId, token)
  return nodeId
}

/** Test hook: lupakan map in-memory saja (simulasi restart proses); yang persisten tetap. */
export function resetNodeTokenMemoryForTest(): void {
  tokens.clear()
  tokenOwners.clear()
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
  if (typeof got !== 'string') return false
  const want = tokens.get(nodeId) ?? (nodeIdForToken(got) === nodeId ? got : undefined)
  if (!want) return false
  const a = Buffer.from(got)
  const b = Buffer.from(want)
  // Panjang beda sudah membocorkan ketidakcocokan lewat `timingSafeEqual` yang melempar, jadi
  // dibandingkan lebih dulu; sisanya waktu-konstan.
  return a.length === b.length && timingSafeEqual(a, b)
}
