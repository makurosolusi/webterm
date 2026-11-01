// Route `POST /api/agent-status`: callback dari hook Claude Code. Dipisah dari `api.ts` supaya file
// itu tetap di bawah budget route-nya; `agentStatusRoute` menjawab satu path dan mengembalikan
// `false` untuk yang lain, jadi integratornya cukup satu baris di `route()`.
//
// Route ini bukan pembaca state: ia hanya MENULIS badge status + transcript node ke registry, dan
// sesekali MEMBALAS dengan satu potong konteks untuk agent pemanggil. Tidak ada jalur balik ke
// client lain di sini.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { db } from './db'
import { sessions } from './sessions'
import { hookStatus, type HookStatusBody } from './hookStatus'
import { buildLinkDoc, findWorkspaceFor } from './contextLink'
import { nextHookContext } from './hookContext'
import { isSafeNodeId } from '../shared/workspace'

/** `transcript_path` hanya DISIMPAN, tidak pernah dibaca di sini. Batas panjangnya menjaga
 *  registry dari nilai raksasa yang di-post berulang; 4096 cukup untuk path absolut terpanjang
 *  di mesin nyata (PATH_MAX 1024 di Linux, 1024 di macOS). */
export const TRANSCRIPT_PATH_MAX = 4096

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => { data += chunk })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
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
  url: URL
): Promise<boolean> {
  if (url.pathname !== '/api/agent-status' || req.method !== 'POST') return false
  const node = url.searchParams.get('node')
  // BATAS INPUT: route ini menulis status/transcript untuk id yang SEPENUHNYA berasal dari
  // query string, jadi ia batas ketiga setelah WebSocket dan registry. Id yang tidak aman
  // diabaikan sebagai no-op (204, tanpa body) — bukan 400 — karena pemanggilnya adalah hook
  // curl di dalam agent yang tidak boleh dibuat gagal oleh nilai aneh.
  if (!isSafeNodeId(node)) { res.statusCode = 204; res.end(); return true }
  // `HookStatusBody` dipakai apa adanya, bukan disalin ulang: field mana yang menentukan status
  // adalah milik `hookStatus`, dan dua daftar yang harus berubah bersamaan pasti akan menyimpang.
  let body: HookStatusBody & { message?: string; transcript_path?: string }
  try { body = JSON.parse(await readBody(req)) } catch { body = {} }
  const status = hookStatus(body)
  if (status) sessions.setStatus(node, status)
  // Hanya DISIMPAN: pembacaan file terjadi di `contextLink`, dan path sepanjang apa pun di sini
  // akan ditulis ulang oleh setiap hook berikutnya pada node yang sama.
  if (typeof body.transcript_path === 'string' && body.transcript_path.length > 0
    && body.transcript_path.length <= TRANSCRIPT_PATH_MAX) {
    sessions.setTranscript(node, body.transcript_path)
  }
  // Balasan hook adalah satu-satunya kanal PUSH ke konteks agent. `nextHookContext` sendiri yang
  // memutuskan event mana layak diumumkan dan mendedupnya antar turn, jadi di sini cukup
  // payload-vs-null; tanpa payload balasannya tetap 204 tanpa body, persis seperti sebelumnya.
  const ws = findWorkspaceFor(db.list(), node)
  const ctx = ws ? nextHookContext(node, body.hook_event_name, buildLinkDoc(ws, node)) : null
  if (ctx) {
    json(res, 200, { hookSpecificOutput: ctx })
    return true
  }
  res.statusCode = 204; res.end(); return true
}
