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
import { isSafeNodeId } from '../shared/workspace'
import { hookStatus, hookStatusReason } from './hookStatus'
import { stateVerified } from './hooks'
import { buildLinkDoc } from './contextLink'
import { nextHookContext } from './hookContext'
import { linkedBrowsers, nextBrowserNotice, releaseCabledBrowsers } from './linkAwareness'
import { nextAwareness } from './webtermAwareness'
import { linkNoteTold } from './linkNoteDelivery'
import { outboxHookContext } from './outbox/outboxRuntime'
import { awarenessExtras } from './awareness/awarenessHook'
import { transcriptPathAllowed } from './transcriptPath'
import { MAX_HOOK_BODY_BYTES, readHookBody, sendHookReply, TRUNCATED_HEADER } from './agentStatusBody'
import { createLogger } from './logs'
import { produceHookEvent } from './events/producers'
import { stashHookStop } from './agentStatusStash'
import { doomLoopBlock } from './permission/permission.loop'
import { checkpointBeforePrompt, defaultDeps, type AgentStatusOptions } from './agentStatusDeps'
import {
  nodeTokenHeader,
  nodeTokenMismatch,
  requesterNodeId,
  STRICT_HOOK_AUTH,
} from './agentStatusAuth'

const log = createLogger('hooks')

export { transcriptPathAllowed } from './transcriptPath'
export type { AgentStatusDeps, AgentStatusOptions } from './agentStatusDeps'
export { nodeTokenMismatch, requesterNodeId, STRICT_HOOK_AUTH } from './agentStatusAuth'

/** Longest `transcript_path` stored (PATH_MAX is 1024 on Linux/macOS); keeps the registry free of giant repeated values. */
export const TRANSCRIPT_PATH_MAX = 4096

export { MAX_HOOK_BODY_BYTES }

export { TRUNCATED_HEADER }

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
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
  // Input boundary: the id comes straight from the query string. An unsafe id is a 204 no-op, not
  // a 400, because the caller is a hook curl inside the agent that must not fail on odd values.
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
  // Strict gate (on by default, agentStatusAuth.ts), checked BEFORE the body is read: a request
  // without this node's token is rejected with nothing buffered, written or recorded.
  const strict = opts?.strictAuth ?? STRICT_HOOK_AUTH
  if (strict && !stateVerified(node, nodeTokenHeader(req))) {
    log.warn('hooks.reject', 'Hook rejected: invalid node token', { ids: { nodeId: node }, status: 403 })
    json(res, 403, { error: 'invalid node token' })
    return true
  }
  // Bounded read (agentStatusBody.ts): a body past the cap is not a 413; only its scanned prefix
  // fields survive, so a finished turn's status is never lost to a long final message.
  const { body, oversize, bytes } = await readHookBody(req)
  if (oversize) log.warn('hooks.oversize', 'Hook body over the cap, status kept from its prefix', { ids: { nodeId: node }, event: body.hook_event_name, bytes })
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
  if (status) deps.setStatus(node, status, hookStatusReason(body))
  // Hanya DISIMPAN: pembacaan file terjadi di `contextLink`, dan path sepanjang apa pun di sini
  // akan ditulis ulang oleh setiap hook berikutnya pada node yang sama.
  if (transcript !== undefined) deps.setTranscript(node, transcript)
  // Hook reply = the only PUSH channel into the agent's context; each source below decides itself
  // which events it announces. No payload keeps the body-less 204.
  const ws = deps.workspaceFor(node)
  const event = body.hook_event_name
  const aware = ws ? nextAwareness(node, event, ws) : null
  const extras = awarenessExtras(node, event, ws)
  const peers = ws ? nextHookContext(node, event, buildLinkDoc(ws, node)) : null
  const browsers = ws ? nextBrowserNotice(node, event, linkedBrowsers(ws, node)) : null
  // A queued link-note for the same wiring change must not follow this announcement.
  if (ws) linkNoteTold(node, event, ws)
  // Senses event goes AFTER setStatus/linkNoteTold (its subscribers read the status just written);
  // a node on no board gets no ledger row (data-209-1: append-only table, no growth per stray POST).
  const mode = deps.modeOf?.(node, ws?.id ?? null)
  // The worker's final message parks in a side slot BEFORE the event (the watcher reacts to hook.Stop synchronously).
  if (ws) stashHookStop(node, event, body as Record<string, unknown>, transcript, requesterNodeId(req) === node, oversize)
  if (ws) produceHookEvent({ nodeId: node, workspaceId: ws.id, body: body as Record<string, unknown>, status, verified: requesterNodeId(req) === node, mode })
  await checkpointBeforePrompt(event, ws, node)
  if (ws && deps.releaseBrowser) releaseCabledBrowsers(event, ws, node, deps.releaseBrowser)
  const mail = outboxHookContext(node, event)
  const text = [aware, extras, peers?.additionalContext, browsers, mail].filter(Boolean).join('\n\n')
  const out: Record<string, unknown> = text && event ? { hookEventName: event, additionalContext: text } : {}
  // An oversize body lost its tool input, so no allow/deny decision is made on it: Claude asks as it would unhooked.
  if (event === 'PreToolUse' && !oversize) {
    // A user Deny rule first (holds in Danger too), then the doom-loop guard.
    const denied = deps.preToolRule?.({ nodeId: node, workspaceId: ws?.id ?? null, body, mode: mode ?? 'auto' }) ?? {}
    Object.assign(out, Object.keys(denied).length ? denied : doomLoopBlock(node, ws?.id ?? null, body))
  }
  if (event === 'PermissionRequest' && deps.answerPermission && !oversize) {
    // Held until a human decides or the wait ends; a vanished curl (Claude closed) stops the wait.
    const gone = new AbortController()
    if (typeof res.on === 'function') res.on('close', () => { if (!res.writableEnded) gone.abort() })
    const title = ws?.nodes.find((n) => n.id === node)?.title || node
    const answer = await deps.answerPermission({ nodeId: node, nodeTitle: title, workspaceId: ws?.id ?? null, body, signal: gone.signal, ...(mode ? { mode } : {}) })
    if (answer) Object.assign(out, answer.hookSpecificOutput)
  }
  sendHookReply(res, out, event, oversize)
  return true
}
