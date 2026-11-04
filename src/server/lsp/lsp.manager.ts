// One language-server process per (workspace root, language), started lazily on the first editor
// connection and killed after IDLE_MS with no connection. A browser tab holds one connection per
// workspace+language; the process outlives it so reopening an editor is warm.
//
// LSP is one session per process (one `initialize`), so:
//  - a reconnect to a warm process gets the cached `initialize` result and its `initialized` is dropped;
//  - a second concurrent connection (another tab) takes the process over and the first is closed
//    (ponytail: takeover, not multiplexing; multiplex with id rewriting if two live tabs matter).
// Docs the leaving connection opened are didClose'd so the next one can didOpen them again.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createLogger } from '../logs'
import { ptyEnv } from '../ptyShell'
import { LSP_CLOSE } from './lsp.contract'
import { LspFramer, frameLsp } from './lsp.framing'
import { resolveLspCommand, type LspCommand, type LspHint, type LspLanguage } from './lsp.resolve'

export const LSP_IDLE_MS = 5 * 60_000

const log = createLogger('lsp')

export interface LspClient {
  send(json: string): void
  close(code: number, reason: string): void
}
export interface LspAttachment {
  /** One JSON-RPC message from the editor. */
  send(json: string): void
  detach(): void
}

interface RpcMsg { id?: string | number | null; method?: string; params?: { textDocument?: { uri?: string }; rootUri?: unknown; workspaceFolders?: unknown }; result?: unknown }
interface Server {
  proc: ChildProcessWithoutNullStreams
  client?: LspClient
  opened: Set<string>
  initResult?: unknown
  initId?: string | number | null
  idle?: ReturnType<typeof setTimeout>
  stderrTail: string
}

export interface LspManagerOpts {
  resolve?: (root: string, language: LspLanguage) => LspCommand | LspHint
  idleMs?: number
  env?: () => NodeJS.ProcessEnv
}

const parse = (json: string): RpcMsg | null => {
  try {
    const m = JSON.parse(json) as unknown
    return m && typeof m === 'object' ? (m as RpcMsg) : null
  } catch {
    return null // not JSON-RPC; the bridge never forwards garbage to the server
  }
}

export class LspManager {
  private servers = new Map<string, Server>()
  private resolve: NonNullable<LspManagerOpts['resolve']>
  private idleMs: number
  private env: () => NodeJS.ProcessEnv

  constructor(o: LspManagerOpts = {}) {
    this.resolve = o.resolve ?? resolveLspCommand
    this.idleMs = o.idleMs ?? LSP_IDLE_MS
    // `ptyEnv` strips webterm's own secrets (root token) from what a workspace tool inherits.
    this.env = o.env ?? (() => ptyEnv(process.env, { interactive: false }))
  }

  /** Running server count (tests, status). */
  get size(): number { return this.servers.size }
  has(root: string, language: LspLanguage): boolean { return this.servers.has(`${root}\0${language}`) }

  attach(root: string, language: LspLanguage, client: LspClient): LspAttachment | LspHint {
    const key = `${root}\0${language}`
    let s = this.servers.get(key)
    if (!s) {
      const cmd = this.resolve(root, language)
      if ('message' in cmd) return cmd
      s = this.start(key, root, cmd)
    }
    const srv = s
    clearTimeout(srv.idle)
    srv.idle = undefined
    if (srv.client) {
      const old = srv.client
      this.leave(srv)
      old.close(LSP_CLOSE.replaced, 'Language server taken over by another window')
    }
    srv.client = client
    const warm = srv.initResult !== undefined
    return {
      send: (json) => {
        if (srv.client !== client) return
        const m = parse(json)
        if (!m) return
        if (m.method === 'initialize') {
          if (warm) return client.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: srv.initResult }))
          srv.initId = m.id
          // The root is the workspace cwd the server already trusts, never what the browser claims.
          const uri = pathToFileURL(root).href
          json = JSON.stringify({ ...m, params: { ...m.params, rootUri: uri, rootPath: root, workspaceFolders: [{ uri, name: basename(root) }] } })
        }
        if (m.method === 'initialized' && warm) return
        const uri = m.params?.textDocument?.uri
        if (m.method === 'textDocument/didOpen' && uri) srv.opened.add(uri)
        if (m.method === 'textDocument/didClose' && uri) srv.opened.delete(uri)
        srv.proc.stdin.write(frameLsp(json))
      },
      detach: () => {
        if (srv.client !== client) return
        this.leave(srv)
        srv.idle = setTimeout(() => this.kill(key), this.idleMs)
      },
    }
  }

  kill(key: string): void {
    const s = this.servers.get(key)
    if (!s) return
    this.servers.delete(key)
    clearTimeout(s.idle)
    s.proc.kill()
  }

  killAll(): void { for (const k of [...this.servers.keys()]) this.kill(k) }

  private leave(s: Server): void {
    for (const uri of s.opened) this.write(s, { jsonrpc: '2.0', method: 'textDocument/didClose', params: { textDocument: { uri } } })
    s.opened.clear()
    s.client = undefined
  }

  private write(s: Server, msg: unknown): void { s.proc.stdin.write(frameLsp(JSON.stringify(msg))) }

  private start(key: string, root: string, cmd: LspCommand): Server {
    const proc = spawn(cmd.cmd, cmd.args, { cwd: root, env: this.env(), stdio: ['pipe', 'pipe', 'pipe'] })
    const s: Server = { proc, opened: new Set(), stderrTail: '' }
    this.servers.set(key, s)
    const framer = new LspFramer()
    proc.stdout.on('data', (chunk: Buffer) => {
      for (const json of framer.feed(chunk)) {
        const m = parse(json)
        if (!m) continue
        if (s.initId !== undefined && m.id === s.initId && m.method === undefined) { s.initResult = m.result ?? null; s.initId = undefined }
        if (s.client) s.client.send(json)
        // Server->client request with nobody attached: answer null so the server does not wait forever.
        else if (m.method && m.id !== undefined && m.id !== null) this.write(s, { jsonrpc: '2.0', id: m.id, result: null })
      }
    })
    proc.stderr.on('data', (c: Buffer) => { s.stderrTail = (s.stderrTail + c.toString('utf8')).slice(-300) })
    // stdin EPIPE after the server died is reported by 'exit' below; without a listener it would crash the process.
    proc.stdin.on('error', () => {})
    const gone = (why: string) => {
      if (this.servers.get(key) === s) this.servers.delete(key)
      clearTimeout(s.idle)
      if (s.client) { const c = s.client; s.client = undefined; c.close(LSP_CLOSE.exited, why.slice(0, 120)) }
    }
    proc.on('error', (e) => {
      log.warn('lsp.spawn.failed', 'Cannot start language server', { cmd: cmd.cmd, cause: e.message })
      gone(`Language server failed to start: ${e.message}`)
    })
    proc.on('exit', (code, signal) => {
      if (code) log.warn('lsp.exit', 'Language server exited', { cmd: cmd.cmd, code, stderr: s.stderrTail.trim() })
      gone(`Language server exited (${signal ?? code})`)
    })
    return s
  }
}

let shared: LspManager | undefined
/** Process-wide manager; its servers die with webterm. */
export function lspManager(): LspManager {
  if (!shared) {
    const m = new LspManager()
    shared = m
    process.once('exit', () => m.killAll())
  }
  return shared
}
