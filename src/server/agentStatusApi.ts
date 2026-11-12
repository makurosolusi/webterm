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
import { linkedBrowsers, nextBrowserNotice, releaseCabledBrowsers } from './linkAwareness'
import { nextAwareness } from './webtermAwareness'
import { linkNoteTold, startLinkNotes } from './linkNoteDelivery'
import { outboxHookContext } from './outbox/outboxRuntime'
import { awarenessExtras } from './awareness/awarenessHook'
import { transcriptPathAllowed } from './transcriptPath'
import { readCappedBody } from './channels/channelHttp'
import { createLogger } from './logs'
import { produceHookEvent } from './events/producers'
import { doomLoopBlock } from './permission/permission.loop'
import { takeCheckpointSafe } from './checkpoint/checkpoint.service'
import { activeBrowser } from './browser/browser.state'
import type { PermissionOutput } from './permission/permission.model'
import type { PermissionAsk } from './permission/permission.wait'
import type { PreToolAsk } from './permission/permission.preTool'
import type { ApprovalModeName } from '../shared/settings.projectApprovalLevels'
import {
  nodeTokenHeader,
  nodeTokenMismatch,
  requesterNodeId,
  STRICT_HOOK_AUTH,
} from './agentStatusAuth'

const log = createLogger('hooks')

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
  /** Gives a browser node's lease back to the human; absent = browser runtime not wired (tests). */
  releaseBrowser?(browserNodeId: string): void
  /** Holds a `PermissionRequest` for a human decision (F3-b); absent = no decision, Claude prompts. */
  answerPermission?(ask: PermissionAsk): Promise<PermissionOutput | null>
  /** PreToolUse: deny by a user Deny rule in every mode (permission.preTool.ts); absent = not wired (tests). */
  preToolRule?(ask: PreToolAsk): Record<string, unknown>
  /** Ask/Auto/Danger the node runs under (launch level, else its workspace's level); absent = not recorded. */
  modeOf?(nodeId: string, workspaceId: string | null): ApprovalModeName
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
  const [{ db }, { sessions }, { answerPermissionLive, preToolRuleLive }, { sessionModeName }] = await Promise.all([import('./db'), import('./sessions'), import('./permission/permission.runtime'), import('./permission/permission.mode')])
  // Satu-satunya titik start loop link-note: hook Claude Code pertama (SessionStart) menyalakannya,
  // jadi tidak ada flag/konfigurasi — dan test dengan deps palsu tidak pernah memuatnya.
  await startLinkNotes()
  return {
    setStatus: (nodeId, status) => sessions.setStatus(nodeId, status),
    setTranscript: (nodeId, path) => sessions.setTranscript(nodeId, path),
    workspaceFor: (nodeId) => findWorkspaceFor(db.list(), nodeId),
    releaseBrowser: (id) => activeBrowser()?.releaseLease(id),
    // Read per request: the Settings toggle applies to the very next prompt, no restart.
    answerPermission: (ask) => answerPermissionLive(ask, db.getSettings().hookReplyApprovals !== false),
    preToolRule: preToolRuleLive,
    modeOf: (nodeId, workspaceId) => sessionModeName(db.getSettings(), nodeId, workspaceId),
  }
}

/**
 * F3-c: a new prompt is about to make the agent act, so its workspace is snapshotted first. Kept
 * above the route on purpose: the route body must not carry its own event list (hooks.test.ts).
 * `takeCheckpointSafe` never throws, so a broken checkpoint cannot fail the hook reply.
 */
async function checkpointBeforePrompt(event: string | undefined, ws: Workspace | null | undefined, nodeId: string): Promise<void> {
  if (event === 'UserPromptSubmit' && ws) await takeCheckpointSafe(ws, { reason: 'prompt', nodeId })
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
    log.warn('hooks.reject', 'Hook rejected: node token does not match node', { ids: { nodeId: node }, status: 403 })
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

  // Strict gate (on by default, agentStatusAuth.ts): a request without this node's token is
  // rejected BEFORE anything is written, so it leaves no status, transcript or ledger row.
  const strict = opts?.strictAuth ?? STRICT_HOOK_AUTH
  if (strict && !stateVerified(node, nodeTokenHeader(req))) {
    log.warn('hooks.reject', 'Hook rejected: invalid node token', { ids: { nodeId: node }, status: 403 })
    json(res, 403, { error: 'invalid node token' })
    return true
  }
  const path = typeof body.transcript_path === 'string' && body.transcript_path.length > 0
    && body.transcript_path.length <= TRANSCRIPT_PATH_MAX ? body.transcript_path : undefined
  // Under strict an out-of-root path is dropped, not the whole hook: a launch line with its own
  // CLAUDE_CONFIG_DIR must keep its status badge, and every reader (contextLinkTranscript,
  // costCapture) refuses such a path anyway.
  const transcript = path !== undefined && (!strict || transcriptPathAllowed(path)) ? path : undefined
  if (path !== undefined && transcript === undefined) log.warn('hooks.reject', 'Hook transcript path outside allowed roots, not stored', { ids: { nodeId: node } })

  const deps = opts?.deps ?? (await defaultDeps())
  const status = hookStatus(body)
  log.debug('hooks.event', 'Hook received', { ids: { nodeId: node }, event: body.hook_event_name, status })
  if (status) deps.setStatus(node, status)
  // Hanya DISIMPAN: pembacaan file terjadi di `contextLink`, dan path sepanjang apa pun di sini
  // akan ditulis ulang oleh setiap hook berikutnya pada node yang sama.
  if (transcript !== undefined) deps.setTranscript(node, transcript)
  // Balasan hook adalah satu-satunya kanal PUSH ke konteks agent. `nextHookContext` sendiri yang
  // memutuskan event mana layak diumumkan dan mendedupnya antar turn, jadi di sini cukup
  // payload-vs-null; tanpa payload balasannya tetap 204 tanpa body, persis seperti sebelumnya.
  const ws = deps.workspaceFor(node)
  // Lima sumber, satu balasan: blok kesadaran webterm (siapa/di mana/apa yang bisa dipakai), ekstra
  // awal sesi (kartu node ber-status peer, gate terbuka, memori prosedural terverifikasi), roster
  // peer context-link, perubahan kabel ke browser node, dan surat outbox `kind: context` (diambil
  // di sini = terkirim tepat sekali; outboxDelivery `takeHookContext` menandainya delivered).
  const event = body.hook_event_name
  const aware = ws ? nextAwareness(node, event, ws) : null
  const extras = awarenessExtras(node, event, ws)
  const peers = ws ? nextHookContext(node, event, buildLinkDoc(ws, node)) : null
  const browsers = ws ? nextBrowserNotice(node, event, linkedBrowsers(ws, node)) : null
  // Hook yang bisa mengumumkan sudah memberi tahu keadaan kabel sekarang: link-note yang mengantre
  // untuk perubahan yang sama tidak boleh menyusul (no double announce).
  if (ws) linkNoteTold(node, event, ws)
  // Senses: AFTER setStatus/linkNoteTold, because the linkNote and wake subscribers read the status
  // this hook just wrote. Trusted only when the request carried this node's own token. A node on no
  // board gets no ledger row (data-209-1): the event table is append-only, so a row per stray POST
  // is permanent growth (temporary mitigation; retention/GC is a later wave).
  const mode = deps.modeOf?.(node, ws?.id ?? null)
  if (ws) produceHookEvent({ nodeId: node, workspaceId: ws.id, body: body as Record<string, unknown>, status, verified: requesterNodeId(req) === node, mode })
  await checkpointBeforePrompt(event, ws, node)
  if (ws && deps.releaseBrowser) releaseCabledBrowsers(event, ws, node, deps.releaseBrowser)
  const mail = outboxHookContext(node, event)
  const text = [aware, extras, peers?.additionalContext, browsers, mail].filter(Boolean).join('\n\n')
  const out: Record<string, unknown> = text && event ? { hookEventName: event, additionalContext: text } : {}
  if (event === 'PreToolUse') {
    // A user Deny rule first (holds in Danger too), then the doom-loop guard.
    const denied = deps.preToolRule?.({ nodeId: node, workspaceId: ws?.id ?? null, body, mode: mode ?? 'auto' }) ?? {}
    Object.assign(out, Object.keys(denied).length ? denied : doomLoopBlock(node, ws?.id ?? null, body))
  }
  if (event === 'PermissionRequest' && deps.answerPermission) {
    // Held until a human decides or the wait ends; a vanished curl (Claude closed) stops the wait.
    const gone = new AbortController()
    if (typeof res.on === 'function') res.on('close', () => { if (!res.writableEnded) gone.abort() })
    const title = ws?.nodes.find((n) => n.id === node)?.title || node
    const answer = await deps.answerPermission({ nodeId: node, nodeTitle: title, workspaceId: ws?.id ?? null, body, signal: gone.signal, ...(mode ? { mode } : {}) })
    if (answer) Object.assign(out, answer.hookSpecificOutput)
  }
  if (Object.keys(out).length > 0) {
    json(res, 200, { hookSpecificOutput: { hookEventName: event, ...out } })
    return true
  }
  res.statusCode = 204; res.end(); return true
}
