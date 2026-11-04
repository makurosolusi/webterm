// Real child processes: the fake stdio JSON-RPC server in __fixtures__/fakeLsp.mjs.
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { LSP_CLOSE } from './lsp.contract'
import { LspFramer, frameLsp } from './lsp.framing'
import { LspManager, type LspAttachment, type LspClient } from './lsp.manager'
import { LSP_HINTS, resolveLspCommand } from './lsp.resolve'

const FAKE = path.join(__dirname, '__fixtures__', 'fakeLsp.mjs')
const ROOT = __dirname

function client() {
  const got: Record<string, unknown>[] = []
  const closed: { code: number; reason: string }[] = []
  const waiters: (() => void)[] = []
  const c: LspClient = {
    send: (json) => { got.push(JSON.parse(json) as Record<string, unknown>); waiters.splice(0).forEach((w) => w()) },
    close: (code, reason) => { closed.push({ code, reason }); waiters.splice(0).forEach((w) => w()) },
  }
  const until = async (pred: () => boolean, ms = 4000) => {
    const end = Date.now() + ms
    while (!pred()) {
      if (Date.now() > end) throw new Error(`timeout; got ${JSON.stringify(got)} closed ${JSON.stringify(closed)}`)
      await new Promise<void>((r) => { waiters.push(r); setTimeout(r, 50) })
    }
  }
  const reply = async (id: string) => { await until(() => got.some((m) => m.id === id)); return got.find((m) => m.id === id)! }
  return { c, got, closed, until, reply }
}

const rpc = (a: LspAttachment, id: string, method: string, params: unknown = {}) => a.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
const note = (a: LspAttachment, method: string, params: unknown = {}) => a.send(JSON.stringify({ jsonrpc: '2.0', method, params }))

let mgr: LspManager | undefined
afterEach(() => mgr?.killAll())

const fakeManager = (idleMs = 60_000) => (mgr = new LspManager({ resolve: () => ({ cmd: process.execPath, args: [FAKE] }), idleMs, env: () => process.env }))

describe('LspFramer', () => {
  it('splits by byte length across chunks, including multi-byte bodies', () => {
    const f = new LspFramer()
    const first = Buffer.from(frameLsp('{"x":"é漢"}'))
    const buf = Buffer.concat([first, Buffer.from(frameLsp('{"y":1}'))])
    expect(f.feed(buf.subarray(0, 7))).toEqual([])
    expect(f.feed(buf.subarray(7, first.length - 1))).toEqual([]) // body cut inside the multi-byte tail
    expect(f.feed(buf.subarray(first.length - 1, first.length + 5))).toEqual(['{"x":"é漢"}'])
    expect(f.feed(buf.subarray(first.length + 5))).toEqual(['{"y":1}'])
  })
})

describe('resolveLspCommand', () => {
  const deps = (files: Record<string, string>, path: string[] = []) => ({
    exists: (p: string) => p in files, readFile: (p: string) => { if (!(p in files)) throw new Error('ENOENT'); return files[p] }, onPath: (n: string) => path.includes(n),
  })
  it('uses TypeScript 7 native tsc --lsp when the workspace has it', () => {
    const r = resolveLspCommand('/w', 'typescript', deps({ '/w/node_modules/typescript/package.json': '{"version":"7.0.2"}', '/w/node_modules/.bin/tsc': '' }, ['typescript-language-server']))
    expect(r).toEqual({ cmd: '/w/node_modules/.bin/tsc', args: ['--lsp', '--stdio'] })
  })
  it('prefers the workspace typescript-language-server over PATH for TS 5', () => {
    const r = resolveLspCommand('/w', 'typescript', deps({ '/w/node_modules/typescript/package.json': '{"version":"5.9.0"}', '/w/node_modules/.bin/tsc': '', '/w/node_modules/.bin/typescript-language-server': '' }))
    expect(r).toEqual({ cmd: '/w/node_modules/.bin/typescript-language-server', args: ['--stdio'] })
    expect(resolveLspCommand('/w', 'typescript', deps({}, ['typescript-language-server']))).toEqual({ cmd: 'typescript-language-server', args: ['--stdio'] })
  })
  it('returns the install hint when nothing is found; pyright when on PATH', () => {
    expect(resolveLspCommand('/w', 'typescript', deps({}))).toEqual(LSP_HINTS.typescript)
    expect(resolveLspCommand('/w', 'python', deps({}))).toEqual(LSP_HINTS.python)
    expect(resolveLspCommand('/w', 'python', deps({}, ['pyright-langserver']))).toEqual({ cmd: 'pyright-langserver', args: ['--stdio'] })
  })
})

describe('LspManager', () => {
  it('starts lazily on first attach and round-trips JSON-RPC both ways', async () => {
    const m = fakeManager()
    expect(m.size).toBe(0)
    const k = client()
    const a = m.attach(ROOT, 'typescript', k.c) as LspAttachment
    expect(m.size).toBe(1)
    rpc(a, 'c-1', 'initialize', { rootUri: 'file:///etc' })
    // The browser's rootUri is replaced by the workspace root the server resolved.
    expect((await k.reply('c-1')).result).toMatchObject({ rootUri: pathToFileURL(ROOT).href, serverInfo: { name: 'fake' } })
    rpc(a, 'c-2', 'test/echo', { hi: 'é' })
    expect((await k.reply('c-2')).result).toEqual({ hi: 'é' })
    note(a, 'textDocument/didOpen', { textDocument: { uri: 'file:///a.ts', languageId: 'typescript', version: 1, text: '' } })
    await k.until(() => k.got.some((g) => g.method === 'textDocument/publishDiagnostics'))
  })

  it('returns the hint (and starts nothing) when no server binary exists', () => {
    const m = (mgr = new LspManager({ resolve: () => LSP_HINTS.typescript }))
    expect(m.attach(ROOT, 'typescript', client().c)).toEqual(LSP_HINTS.typescript)
    expect(m.size).toBe(0)
  })

  it('kills the server after the idle window with no connection, and a reattach in the window is warm', async () => {
    const m = fakeManager(150)
    const k1 = client()
    const a1 = m.attach(ROOT, 'typescript', k1.c) as LspAttachment
    rpc(a1, 'i-1', 'initialize')
    const pid = ((await k1.reply('i-1')).result as { serverInfo: { version: string } }).serverInfo.version
    note(a1, 'textDocument/didOpen', { textDocument: { uri: 'file:///a.ts', languageId: 'typescript', version: 1, text: '' } })
    a1.detach()
    // Warm reattach: initialize answered from cache (same pid), the old doc was didClose'd.
    const k2 = client()
    const a2 = m.attach(ROOT, 'typescript', k2.c) as LspAttachment
    rpc(a2, 'i-2', 'initialize')
    expect(((await k2.reply('i-2')).result as { serverInfo: { version: string } }).serverInfo.version).toBe(pid)
    rpc(a2, 'o-1', 'test/opened')
    expect((await k2.reply('o-1')).result).toEqual([])
    a2.detach()
    expect(m.has(ROOT, 'typescript')).toBe(true)
    await new Promise((r) => setTimeout(r, 400))
    expect(m.has(ROOT, 'typescript')).toBe(false)
  })

  it('a second connection takes over; the first is closed with the replaced code', async () => {
    const m = fakeManager()
    const k1 = client()
    m.attach(ROOT, 'typescript', k1.c)
    const k2 = client()
    m.attach(ROOT, 'typescript', k2.c)
    expect(k1.closed).toEqual([{ code: LSP_CLOSE.replaced, reason: expect.any(String) }])
    expect(m.size).toBe(1)
  })

  it('forwards server->client requests to the editor; closes the editor socket when the server dies', async () => {
    const m = fakeManager()
    const k = client()
    const a = m.attach(ROOT, 'typescript', k.c) as LspAttachment
    rpc(a, 'q', 'test/ask')
    await k.until(() => k.got.some((g) => g.method === 'workspace/configuration'))
    rpc(a, 'd', 'test/die')
    await k.until(() => k.closed.length > 0)
    expect(k.closed[0]!.code).toBe(LSP_CLOSE.exited)
    expect(m.size).toBe(0)
  })

  it('drops non-JSON input instead of forwarding it', async () => {
    const m = fakeManager()
    const k = client()
    const a = m.attach(ROOT, 'typescript', k.c) as LspAttachment
    a.send('not json')
    rpc(a, 'e', 'test/echo', 1)
    expect((await k.reply('e')).result).toBe(1)
  })
})
