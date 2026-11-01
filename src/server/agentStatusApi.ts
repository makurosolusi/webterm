// Route `POST /api/agent-status`: callback dari hook Claude Code. Dipisah dari `api.ts` supaya file
// itu tetap di bawah budget route-nya; `agentStatusRoute` menjawab satu path dan mengembalikan
// `false` untuk yang lain, jadi integratornya cukup satu baris di `route()`.
//
// Route ini bukan pembaca state: ia hanya MENULIS badge status + transcript node ke registry, dan
// sesekali MEMBALAS dengan satu potong konteks untuk agent pemanggil. Tidak ada jalur balik ke
// client lain di sini.
//
// Gerbang identitas (token→node) tinggal di `agentStatusAuth` dan di-re-export dari sini supaya
// pemanggil lama (`contextLinkApi`, test) tidak berubah.
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AgentStatus, Workspace } from '../shared/workspace'
import { isSafeNodeId } from '../shared/workspace'
import { hookStatus, type HookStatusBody } from './hookStatus'
import { stateVerified } from './hooks'
import { buildLinkDoc, findWorkspaceFor } from './contextLink'
import { nextHookContext } from './hookContext'
import { transcriptPathAllowed } from './transcriptPath'
import { readCappedBody } from './channels/channelHttp'
import {
  nodeTokenHeader,
  nodeTokenMismatch,
  requesterNodeId,
  STRICT_HOOK_AUTH,
} from './agentStatusAuth'

export { transcriptPathAllowed } from './transcriptPath'
export { nodeTokenMismatch, requesterNodeId, STRICT_HOOK_AUTH } from './agentStatusAuth'

/** `transcript_path` hanya DISIMPAN, tidak pernah dibaca di sini. Batas panjangnya menjaga
 *  registry dari nilai raksasa yang di-post berulang; 4096 cukup untuk path absolut terpanjang
 *  di mesin nyata (PATH_MAX 1024 di Linux, 1024 di macOS). */
export const TRANSCRIPT_PATH_MAX = 4096

/** Batas body hook. Hook agent mengirim JSON kecil; 256 KiB lega tanpa menampung payload raksasa
 *  dari sembarang sesi agent yang memegang token nodenya. */
export const MAX_HOOK_BODY_BYTES = 256 * 1024

/** Sisi tulis route, di-inject supaya route bisa diuji tanpa `bun:sqlite`/PTY. */
export interface AgentStatusDeps {
  setStatus(nodeId: string, status: AgentStatus): void
  setTranscript(nodeId: string, path: string): void
  workspaceFor(nodeId: string): Workspace | null | undefined
}

/** Opsi test: override gerbang + dependency. Produksi memanggil route tanpa argumen keempat. */
export interface AgentStatusOptions {
  strictAuth?: boolean
  deps?: AgentStatusDeps
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}

/**
 * Dependency default. Diimpor DINAMIS: `db`/`sessions` menarik `bun:sqlite` dan PTY, jadi impor
 * statis akan membuat modul route ini tidak bisa dimuat test node-env (yang menguji gerbang auth
 * dengan dependency palsu).
 */
async function defaultDeps(): Promise<AgentStatusDeps> {
  const [{ db }, { sessions }] = await Promise.all([import('./db'), import('./sessions')])
  return {
    setStatus: (nodeId, status) => sessions.setStatus(nodeId, status),
    setTranscript: (nodeId, path) => sessions.setTranscript(nodeId, path),
    workspaceFor: (nodeId) => findWorkspaceFor(db.list(), nodeId),
  }
}

/**
 * Menjawab `POST /api/agent-status` dan mengembalikan `true`; `false` bila method/path bukan milik
 * modul ini (pemanggil lalu melanjutkan ke route berikutnya, sampai 404 di `api.ts`).
 *
 * 204 tetap TANPA body: sebuah `json(res, 204)` pun akan body-less, tapi jalur lamanya dijaga apa
 * adanya supaya kontrak 204-nya tidak bergeser diam-diam.
 */
export async function agentStatusRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  opts?: AgentStatusOptions
): Promise<boolean> {
  if (url.pathname !== '/api/agent-status' || req.method !== 'POST') return false
  const node = url.searchParams.get('node')
  // BATAS INPUT: route ini menulis status/transcript untuk id yang SEPENUHNYA berasal dari
  // query string, jadi ia batas ketiga setelah WebSocket dan registry. Id yang tidak aman
  // diabaikan sebagai no-op (204, tanpa body) — bukan 400 — karena pemanggilnya adalah hook
  // curl di dalam agent yang tidak boleh dibuat gagal oleh nilai aneh.
  if (!isSafeNodeId(node)) { res.statusCode = 204; res.end(); return true }
  // IKATAN TOKEN→NODE, TANPA SYARAT (tidak digerbangi strict auth). Sebuah token node hanya boleh
  // bertindak untuk node-nya sendiri; tanpa pemeriksaan ini sesi agent mana pun bisa menulis
  // status/transcript node tetangganya cukup dengan mengganti `?node=`. Ditolak SEBELUM body
  // dibaca dan sebelum `setStatus`/`setTranscript`, jadi permintaan yang ditolak tidak menulis apa
  // pun. Root token / tanpa token / token asing tetap `undefined` → fail-open lama dipertahankan.
  if (nodeTokenMismatch(requesterNodeId(req), node)) {
    json(res, 403, { error: 'node token does not match node' })
    return true
  }
  // `HookStatusBody` dipakai apa adanya, bukan disalin ulang: field mana yang menentukan status
  // adalah milik `hookStatus`, dan dua daftar yang harus berubah bersamaan pasti akan menyimpang.
  // Body dibaca BERBATAS: overflow ditolak sebelum `setStatus`/`setTranscript` mana pun.
  const read = await readCappedBody(req, MAX_HOOK_BODY_BYTES)
  if (!read.ok && read.reason === 'too_large') {
    json(res, 413, { error: 'payload_too_large' })
    return true
  }
  let body: HookStatusBody & { message?: string; transcript_path?: string }
  try { body = JSON.parse(read.ok ? read.body : '') } catch { body = {} }

  // Gerbang strict: keduanya diperiksa SEBELUM apa pun ditulis, jadi permintaan yang ditolak
  // tidak meninggalkan jejak status/transcript. Saat mati (default), tidak ada satu pun cabang
  // di bawah ini yang berjalan — perilaku fail-open lama dipertahankan huruf per huruf.
  if (opts?.strictAuth ?? STRICT_HOOK_AUTH) {
    if (!stateVerified(node, nodeTokenHeader(req))) {
      json(res, 403, { error: 'invalid node token' })
      return true
    }
    const raw = body.transcript_path
    if (typeof raw === 'string' && raw.length > 0
      && (raw.length > TRANSCRIPT_PATH_MAX || !transcriptPathAllowed(raw))) {
      json(res, 403, { error: 'transcript path outside allowed roots' })
      return true
    }
  }

  const deps = opts?.deps ?? (await defaultDeps())
  const status = hookStatus(body)
  if (status) deps.setStatus(node, status)
  // Hanya DISIMPAN: pembacaan file terjadi di `contextLink`, dan path sepanjang apa pun di sini
  // akan ditulis ulang oleh setiap hook berikutnya pada node yang sama.
  if (typeof body.transcript_path === 'string' && body.transcript_path.length > 0
    && body.transcript_path.length <= TRANSCRIPT_PATH_MAX) {
    deps.setTranscript(node, body.transcript_path)
  }
  // Balasan hook adalah satu-satunya kanal PUSH ke konteks agent. `nextHookContext` sendiri yang
  // memutuskan event mana layak diumumkan dan mendedupnya antar turn, jadi di sini cukup
  // payload-vs-null; tanpa payload balasannya tetap 204 tanpa body, persis seperti sebelumnya.
  const ws = deps.workspaceFor(node)
  const ctx = ws ? nextHookContext(node, body.hook_event_name, buildLinkDoc(ws, node)) : null
  if (ctx) {
    json(res, 200, { hookSpecificOutput: ctx })
    return true
  }
  res.statusCode = 204; res.end(); return true
}
