// JSON-RPC client for one `/ws/lsp` socket (one WS text frame = one message). Sends `initialize`
// on open and holds every other outgoing message until the server answered it, so callers never
// have to order their didOpen/hover against the handshake.

/** Same strings as src/server/lsp/lsp.contract.ts (the client does not import server code; a test pins them equal). */
export const LSP_WS_PATH = '/ws/lsp'
export const LSP_UNAVAILABLE = 'lsp-unavailable'

export interface LspHint { message: string; command: string }
type Pending = { resolve(v: unknown): void; reject(e: Error): void }
interface RpcMsg { id?: string | number | null; method?: string; params?: unknown; result?: unknown; error?: { message: string } }

/** Minimal capabilities: the features this editor wires (markdown hover, snippet completion, LocationLink, signature help, symbol tree). */
const CLIENT_CAPABILITIES = {
  textDocument: {
    synchronization: { dynamicRegistration: false },
    hover: { contentFormat: ['markdown', 'plaintext'] },
    completion: { completionItem: { snippetSupport: true, insertReplaceSupport: true, labelDetailsSupport: true } },
    definition: { linkSupport: true },
    references: {},
    rename: { prepareSupport: false },
    signatureHelp: { signatureInformation: { documentationFormat: ['markdown', 'plaintext'], parameterInformation: { labelOffsetSupport: true }, activeParameterSupport: true }, contextSupport: true },
    documentSymbol: { hierarchicalDocumentSymbolSupport: true },
    publishDiagnostics: {},
  },
  workspace: { configuration: true, workspaceEdit: { documentChanges: true } },
}

export class LspConnection {
  private seq = 0
  private readonly prefix = Math.random().toString(36).slice(2, 8) // ids unique per socket: a warm server may still answer an old one
  private pending = new Map<string, Pending>()
  private queue: string[] = []
  private initialized = false
  private notifyCb: (method: string, params: unknown) => void = () => {}
  /** Install hint the server sent before closing (no language server for this workspace). */
  hint: LspHint | null = null
  readonly ready: Promise<unknown>

  constructor(private ws: WebSocket, rootUri: string | null, onClose: (c: LspConnection, code: number) => void) {
    let initDone!: (v: unknown) => void
    let initFail!: (e: Error) => void
    this.ready = new Promise((res, rej) => { initDone = res; initFail = rej })
    this.ready.catch(() => {}) // a closed socket rejects it; callers that care await it themselves
    ws.onopen = () => {
      this.raw({ id: this.nextId(), method: 'initialize', params: { processId: null, rootUri, capabilities: CLIENT_CAPABILITIES, workspaceFolders: rootUri ? [{ uri: rootUri, name: 'workspace' }] : null } }, initDone, initFail)
    }
    ws.onmessage = (ev) => this.receive(String(ev.data))
    ws.onclose = (ev) => {
      for (const p of this.pending.values()) p.reject(new Error(`language server closed (${ev.code})`))
      this.pending.clear()
      initFail(new Error(`language server closed (${ev.code})`))
      onClose(this, ev.code)
    }
  }

  request<T>(method: string, params: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => this.raw({ id: this.nextId(), method, params }, resolve as (v: unknown) => void, reject))
  }

  notify(method: string, params: unknown): void { this.send({ method, params }) }

  onNotification(cb: (method: string, params: unknown) => void): void { this.notifyCb = cb }

  close(): void { this.ws.close() }

  private nextId(): string { return `${this.prefix}-${++this.seq}` }

  private raw(msg: RpcMsg, resolve: (v: unknown) => void, reject: (e: Error) => void): void {
    this.pending.set(String(msg.id), { resolve, reject })
    if (msg.method === 'initialize') this.ws.send(JSON.stringify({ jsonrpc: '2.0', ...msg }))
    else this.send(msg)
  }

  private send(msg: RpcMsg): void {
    const json = JSON.stringify({ jsonrpc: '2.0', ...msg })
    if (this.initialized && this.ws.readyState === 1) this.ws.send(json)
    else this.queue.push(json)
  }

  private receive(json: string): void {
    let m: RpcMsg & { webterm?: string; message?: string; command?: string }
    try { m = JSON.parse(json) } catch { return } // not JSON-RPC: nothing to route
    if (m.webterm === LSP_UNAVAILABLE) { this.hint = { message: String(m.message), command: String(m.command) }; return }
    if (m.method && m.id !== undefined && m.id !== null) {
      // Server->client request: configuration gets one null per item, the rest (registerCapability, progress) a null result.
      const items = (m.params as { items?: unknown[] } | undefined)?.items
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: m.method === 'workspace/configuration' ? (items ?? []).map(() => null) : null }))
      return
    }
    if (m.method) return this.notifyCb(m.method, m.params)
    const p = this.pending.get(String(m.id))
    if (!p) return
    this.pending.delete(String(m.id))
    if (m.error) {
      p.reject(new Error(m.error.message))
      if (String(m.id) === `${this.prefix}-1`) this.ws.close() // initialize refused: the session is unusable
      return
    }
    p.resolve(m.result ?? null)
    if (!this.initialized && String(m.id) === `${this.prefix}-1`) {
      this.initialized = true
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} }))
      for (const q of this.queue.splice(0)) this.ws.send(q)
    }
  }
}
