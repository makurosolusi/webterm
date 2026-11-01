import type { IncomingMessage, ServerResponse } from 'node:http'
import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import npath from 'node:path'
import { db } from './db'
import { sessions } from './sessions'
import { settingsRoute } from './settingsApi'
import { workspacesRoute } from './workspacesApi'
import { fsApiRoute } from './fsApi'
import { gitInfoRoute } from './gitInfo'
import { readErrorResult } from './fsOps'
import { hookStatus, type HookStatusBody } from './hookStatus'
import { renderForRequester, buildLinkDoc, findWorkspaceFor, CONTEXT_LINK_VERBS, type ContextLinkVerb } from './contextLink'
import { nextHookContext } from './hookContext'
import { isSafeNodeId } from '../shared/workspace'

/** `transcript_path` hanya DISIMPAN, tidak pernah dibaca di sini. Batas panjangnya menjaga
 *  registry dari nilai raksasa yang di-post berulang; 4096 cukup untuk path absolut terpanjang
 *  di mesin nyata (PATH_MAX 1024 di Linux, 1024 di macOS). */
export const TRANSCRIPT_PATH_MAX = 4096

function json(res: ServerResponse, status: number, body?: unknown): void {
  res.statusCode = status
  // No body at all when a route omits one (204): a JSON body on a 204 is a contract change.
  if (body === undefined) { res.end(); return }
  const data = JSON.stringify(body)
  res.setHeader('Content-Type', 'application/json')
  res.end(data)
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => { data += chunk })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

/** Push the stored shell/scrollback/agent settings into the live PTY factory. Boot + every PUT. */
export function applyPtyOptions(): void {
  const s = db.getSettings()
  sessions.options = {
    shell: s.defaultShell,
    scrollbackBytes: s.scrollbackBytes,
    // `--permission-mode auto` baru ada di Claude Code >= 2.1.71 dan webterm belum punya probe
    // versi CLI, jadi mode default 'auto' diteruskan sebagai ABSEN: peluncuran claude tetap polos
    // persis seperti sebelum setting ini ada. Mode pilihan user eksplisit tetap diteruskan.
    claudePermissionMode: s.claudePermissionMode === 'auto' ? undefined : s.claudePermissionMode,
    hookReplyApprovals: s.hookReplyApprovals,
  }
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url || '/', 'http://x')
  const path = url.pathname
  const method = req.method || 'GET'

  // /api/workspaces[/:id] and /api/active; returns null for anything else, including a method
  // this family does not answer, which then falls through to the 404 at the bottom.
  // A 204 route answers WITHOUT a `body` key, and `json` keeps those body-less.
  const wsRes = await workspacesRoute(db, path, method, () => readBody(req))
  if (wsRes) return json(res, wsRes.status, wsRes.body)

  if (path === '/api/settings') {
    await settingsRoute(req, res, method)
    // A saved defaultShell/scrollbackBytes must reach the NEXT spawned PTY without a restart.
    if (method === 'PUT') applyPtyOptions()
    return
  }

  // Six filesystem verbs under /api/fs/<verb>; returns null for anything else, including the
  // exact /api/fs folder picker below, whose response shape is different.
  // `read`/`read-binary` throw on an unreadable file (see the fsOps header): 200 with an empty
  // body looks like a readable EMPTY file, and the editor then truncates it on the next save.
  const fsRes = await fsApiRoute(path, method, url.searchParams, () => readBody(req))
    .catch(readErrorResult)
  if (fsRes) return json(res, fsRes.status, fsRes.body)

  // Batch git state for a set of node cwds; null for anything else, including a GET of this path.
  const gitRes = await gitInfoRoute(path, method, () => readBody(req))
  if (gitRes) return json(res, gitRes.status, gitRes.body)

  // Hook callback from a claude session (body is the hook stdin JSON).
  if (path === '/api/agent-status' && method === 'POST') {
    const node = url.searchParams.get('node')
    // BATAS INPUT: route ini menulis status/transcript untuk id yang SEPENUHNYA berasal dari
    // query string, jadi ia batas ketiga setelah WebSocket dan registry. Id yang tidak aman
    // diabaikan sebagai no-op (204, tanpa body) — bukan 400 — karena pemanggilnya adalah hook
    // curl di dalam agent yang tidak boleh dibuat gagal oleh nilai aneh.
    if (!isSafeNodeId(node)) { res.statusCode = 204; res.end(); return }
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
    if (ctx) return json(res, 200, { hookSpecificOutput: ctx })
    res.statusCode = 204; res.end(); return
  }

  // Read-only context-link: a linked node reads a bridged peer's transcript/terminal.
  if (path === '/api/context-link' && method === 'GET') {
    // `node` yang ADA tapi tidak aman ditolak jujur, bukan diteruskan: id itu menjadi kunci
    // `findWorkspaceFor`, dan menerimanya sebagai string bebas berarti route ini punya domain
    // input yang berbeda dari WebSocket. Tanpa `node` sama sekali, perilaku lama tetap: pemanggil
    // non-agent mendapat balasan "nothing to read" dari `renderForRequester`.
    const nodeParam = url.searchParams.get('node')
    if (nodeParam !== null && !isSafeNodeId(nodeParam)) {
      return json(res, 400, { error: 'invalid node' })
    }
    const requester = nodeParam || ''
    const raw = url.searchParams.get('verb') || 'list'
    const verb = (CONTEXT_LINK_VERBS as string[]).includes(raw) ? (raw as ContextLinkVerb) : 'list'
    const want = url.searchParams.get('want') || undefined
    const n = url.searchParams.get('n') || undefined
    const text = await renderForRequester(requester, verb, { node: want, n })
    res.statusCode = 200
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.end(text)
    return
  }

  // AI name-gen: spawn claude -p on a node's terminal buffer, return a suggested title.
  if (path === '/api/generate-name' && method === 'GET') {
    const node = url.searchParams.get('node') || ''
    const { generateName } = await import('./nameGen')
    return json(res, 200, await generateName(node))
  }

  // Server-side folder picker: list subdirectories of a dir (dotfiles hidden).
  if (path === '/api/fs' && method === 'GET') {
    const dir = url.searchParams.get('path') || homedir()
    try {
      const entries = await readdir(dir, { withFileTypes: true })
      const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name).sort()
      const parent = npath.dirname(dir)
      return json(res, 200, { path: dir, parent: parent === dir ? null : parent, dirs })
    } catch {
      return json(res, 404, { error: 'cannot read dir' })
    }
  }

  json(res, 404, { error: 'unknown route' })
}

// Returns true when it has taken over the response; false lets the caller fall
// through to Vite/static. The response is finished asynchronously.
//
// Every route rides the one net below. A dropped rejection left the socket open with no status and
// no body until the client timed out, so the net lives here, not per route family: the next route
// that throws is covered without touching it.
export function handleApi(req: IncomingMessage, res: ServerResponse): boolean {
  if (!req.url || !req.url.startsWith('/api/')) return false
  route(req, res).catch((err: unknown) => {
    // Method + pathname ONLY: the query string carries the auth token (TOKEN_PARAM), and the
    // error itself can quote absolute paths or request bodies — so it goes to the log, never
    // to the body the client reads.
    console.error(`api ${req.method || 'GET'} ${new URL(req.url || '/', 'http://x').pathname} failed:`, err)
    if (res.writableEnded) return
    // A partially sent response (context-link flushes headers before its body) cannot take a
    // status any more — setting one throws again. Just close what the client already has.
    if (res.headersSent) { res.end(); return }
    json(res, 500, { error: 'internal error' })
  })
  return true
}
