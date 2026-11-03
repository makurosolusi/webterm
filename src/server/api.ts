import type { IncomingMessage, ServerResponse } from 'node:http'
import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import npath from 'node:path'
import { db } from './db'
import { sessions } from './sessions'
import { settingsRoute } from './settingsApi'
import { ENV_SETTINGS_PATH, envSettingsRoute } from './envSettings.api'
import { envSettingsApiDeps } from './envSettings.runtime'
import { workspacesRoute } from './workspacesApi'
import { agentStatusRoute } from './agentStatusApi'
import { handleControlHttp } from './control/mount'
import { inboxRoute } from './inboxApi'
import { memoryRoute } from './memoryApi'
import { memoryWriteRoute } from './memoryWriteApi'
import { orchestratorRoute } from './orchestratorApi'
import { approvalHumanRoute } from './approvalHumanApi'
import { activeLedgerRuntime } from './ledger/ledgerRuntimeState'
import { contextLinkRoute } from './contextLinkApi'
import { centralChatRoute } from './centralChatApi'
import { fsApiRoute } from './fsApi'
import { gitInfoRoute } from './gitInfo'
import { readErrorResult } from './fsOps'
import { extendedApiRoute } from './extendedApi'
import { cappedBodyGetter, WORKSPACES_BODY_MAX_BYTES } from './cappedRequestBody'
import { MEMORY_WRITE_BODY_MAX_BYTES } from './memoryWriteApi'
import { logsRoute, startRequestLog } from './logs'
import { activeBrowser } from './browser/browser.state'
import { BROWSER_BODY_MAX_BYTES } from './browserApi'

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
    // Absen (flag browser off) = tidak ada env capability browser; opsi ini DITIMPA utuh tiap panggilan.
    browser: activeBrowser()?.sessionHook,
  }
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url || '/', 'http://x')
  const path = url.pathname
  const method = req.method || 'GET'

  // Log API first: same /api gate as settings (applied in index.ts), own body/SSE handling.
  if (await logsRoute(req, res, url, method)) return

  // /api/workspaces[/:id] and /api/active; returns null for anything else, including a method
  // this family does not answer, which then falls through to the 404 at the bottom.
  // A 204 route answers WITHOUT a `body` key, and `json` keeps those body-less.
  // Body-nya berbatas 1 MiB dan hanya dibaca untuk POST/PUT (`cappedBodyGetter`): snapshot
  // workspace yang wajar ada jauh di bawah itu, sedangkan body GET/DELETE tidak pernah menyentuh
  // stream. Reader `fs`/`git` di bawah tetap TANPA cap — isi file boleh besar.
  const wsRes = await workspacesRoute(db, path, method, cappedBodyGetter(req, method, WORKSPACES_BODY_MAX_BYTES))
  if (wsRes) return json(res, wsRes.status, wsRes.body)

  // /api/browser/*: hanya ada bila runtime browser hidup (flag on). Gerbang auth di index.ts sudah
  // menolak node-token (prefix ini tidak ada di allowlist node-token).
  const browserRes = await activeBrowser()?.api(method, path, cappedBodyGetter(req, method, BROWSER_BODY_MAX_BYTES))
  if (browserRes) return json(res, browserRes.status, browserRes.body)

  if (path === ENV_SETTINGS_PATH) return envSettingsRoute(req, res, method, envSettingsApiDeps())

  if (path === '/api/settings') {
    await settingsRoute(req, res, method, db)
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
  if (await agentStatusRoute(req, res, url)) return

  // Headless control plane (/api/control/*): false = not this family, keep falling through.
  if (await handleControlHttp(req, res, url, () => readBody(req))) return

  // Read-only context-link: a linked node reads a bridged peer's transcript/terminal.
  if (await contextLinkRoute(req, res, url)) return

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

  // Read-only ledger projections for the UI (inbox/memory/orchestrator). Ledger off answers 503
  // `ledger_off` instead of an empty list; null from a family = keep falling through to 404.
  const ledger = activeLedgerRuntime()
  // Central chat (exact paths only; flags inside). Mounted before the read-only projections
  // and the 404 fallback so its SSE response can stay open; portfolio routes are untouched.
  if (await centralChatRoute(req, res, url, { ledger })) return
  if (await extendedApiRoute(req, res, url, ledger)) return
  if (await approvalHumanRoute(req, res, url)) return
  // Memory writes (claim/promote). Body capped at 64 KiB and read lazily, so the read-only GETs
  // below never touch the stream. Authority is derived here as root human, never from the payload.
  const memoryWrite = await memoryWriteRoute(
    path,
    method,
    cappedBodyGetter(req, method, MEMORY_WRITE_BODY_MAX_BYTES),
    ledger
  )
  if (memoryWrite) return json(res, memoryWrite.status, memoryWrite.body)
  for (const family of [inboxRoute, memoryRoute, orchestratorRoute]) {
    const result = family(path, method, url.searchParams, ledger)
    if (result) return json(res, result.status, result.body)
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
  const requestLog = startRequestLog(req, res)
  route(req, res).catch((err: unknown) => {
    // Method + pathname ONLY (inside startRequestLog): the query string carries the auth token
    // (TOKEN_PARAM), and the error itself can quote absolute paths or request bodies — so it goes
    // to the log, never to the body the client reads.
    requestLog.fail(err)
    if (res.writableEnded) return
    // A partially sent response (context-link flushes headers before its body) cannot take a
    // status any more — setting one throws again. Just close what the client already has.
    if (res.headersSent) { res.end(); return }
    json(res, 500, { error: 'internal error' })
  })
  return true
}
