// Kontrak route hook `POST /api/agent-status`; strict auth is the default (data-209-1).
//
// Modul route sekarang menerima dependency + override gerbang, jadi test ini menjalankan route
// SUNGGUHAN (bukan membaca source): request palsu berbentuk IncomingMessage, response pencatat,
// dan spy untuk sisi tulis registry. `db`/`sessions` tidak pernah dimuat — keduanya menarik
// `bun:sqlite`/PTY yang tidak ada di node-env.
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// `dataDir()` dipanggil route saat strict; arahkan ke temp supaya tidak menyentuh data dir user.
const SANDBOX = mkdtempSync(join(tmpdir(), 'wt-agent-status-'))
process.env.WEBTERM_DATA_DIR = join(SANDBOX, 'data')

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AgentStatus, Workspace } from '../shared/workspace'
import { forgetNodeToken, nodeToken, NODE_TOKEN_HEADER } from './hooks'
import { TOKEN_HEADER } from './auth'
import {
  agentStatusRoute,
  MAX_HOOK_BODY_BYTES,
  transcriptPathAllowed,
  TRANSCRIPT_PATH_MAX,
  type AgentStatusDeps,
} from './agentStatusApi'
import { eventBus } from './events/eventBus'
import type { SenseEvent } from './events/eventModel'

/** Request minimal: `readCappedBody` hanya butuh emitter 'data'/'end' + `resume`, route butuh
 *  method + headers. Body dikirim sebagai chunk Buffer, persis seperti stream node:http. */
function mockChunkedReq(chunks: string[], headers: Record<string, string> = {}): IncomingMessage {
  const req = new EventEmitter() as unknown as IncomingMessage
  ;(req as unknown as { method: string }).method = 'POST'
  ;(req as unknown as { headers: Record<string, string> }).headers = headers
  ;(req as unknown as { resume: () => void }).resume = () => {}
  process.nextTick(() => {
    for (const chunk of chunks) req.emit('data', Buffer.from(chunk))
    req.emit('end')
  })
  return req
}

function mockReq(body: unknown, headers: Record<string, string> = {}): IncomingMessage {
  return mockChunkedReq([typeof body === 'string' ? body : JSON.stringify(body)], headers)
}

interface MockRes extends ServerResponse {
  statusCode: number
  headers: Record<string, string>
  body: string
}

function mockRes(): MockRes {
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: '',
    setHeader(name: string, value: string) { this.headers[name] = value },
    end(chunk?: string) { this.body = chunk ?? '' },
  }
  return res as unknown as MockRes
}

interface Writes {
  status: { node: string; status: AgentStatus }[]
  transcript: { node: string; path: string }[]
}

function deps(overrides: Partial<AgentStatusDeps> = {}): AgentStatusDeps & { writes: Writes } {
  const writes: Writes = { status: [], transcript: [] }
  const d = {
    writes,
    setStatus: (node: string, status: AgentStatus) => { writes.status.push({ node, status }) },
    setTranscript: (node: string, path: string) => { writes.transcript.push({ node, path }) },
    workspaceFor: (): Workspace | null => null,
    ...overrides,
  }
  return d
}

const URL_FOR = (node: string): URL =>
  new URL(`http://127.0.0.1:8700/api/agent-status?node=${encodeURIComponent(node)}`)

const NODE = 'node-strict-1'
const TOKEN = nodeToken(NODE)

let claudeRoot: string

beforeEach(() => {
  claudeRoot = join(mkdtempSync(join(tmpdir(), 'wt-claude-')), 'projects')
  mkdirSync(claudeRoot, { recursive: true })
  process.env.CLAUDE_CONFIG_DIR = join(claudeRoot, '..')
})

afterEach(() => {
  delete process.env.CLAUDE_CONFIG_DIR
})

describe('strict auth MATI (WEBTERM_STRICT_HOOK_AUTH=0) — fail-open lama', () => {
  it('menerapkan status tanpa token', async () => {
    const res = mockRes()
    const d = deps()
    const handled = await agentStatusRoute(
      mockReq({ hook_event_name: 'Stop' }), res, URL_FOR(NODE), { strictAuth: false, deps: d }
    )
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(204)
    expect(d.writes.status).toEqual([{ node: NODE, status: 'waiting' }])
  })

  it('menyimpan transcript_path apa adanya, termasuk nilai yang tidak akan lolos strict', async () => {
    const res = mockRes()
    const d = deps()
    await agentStatusRoute(
      mockReq({ hook_event_name: 'Stop', transcript_path: '../../etc/passwd' }),
      res, URL_FOR(NODE), { strictAuth: false, deps: d }
    )
    expect(res.statusCode).toBe(204)
    expect(d.writes.transcript).toEqual([{ node: NODE, path: '../../etc/passwd' }])
  })
})

describe('strict auth NYALA — token node wajib', () => {
  it('menolak request tanpa token dengan 403 dan tidak menulis apa pun', async () => {
    const res = mockRes()
    const d = deps()
    await agentStatusRoute(
      mockReq({ hook_event_name: 'Stop' }, {}), res, URL_FOR(NODE), { strictAuth: true, deps: d }
    )
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body)).toEqual({ error: 'invalid node token' })
    expect(d.writes).toEqual({ status: [], transcript: [] })
  })

  it('menolak token palsu / token milik node lain dengan 403', async () => {
    for (const bad of ['not-a-token', nodeToken('another-node')]) {
      const res = mockRes()
      const d = deps()
      await agentStatusRoute(
        mockReq({ hook_event_name: 'Stop' }, { [NODE_TOKEN_HEADER]: bad }),
        res, URL_FOR(NODE), { strictAuth: true, deps: d }
      )
      expect(res.statusCode).toBe(403)
      expect(d.writes).toEqual({ status: [], transcript: [] })
    }
  })

  it('menerima token sah, menulis status, dan tetap 204 tanpa payload konteks', async () => {
    const res = mockRes()
    const d = deps()
    await agentStatusRoute(
      mockReq({ hook_event_name: 'Stop' }, { [NODE_TOKEN_HEADER]: TOKEN }),
      res, URL_FOR(NODE), { strictAuth: true, deps: d }
    )
    expect(res.statusCode).toBe(204)
    expect(d.writes.status).toEqual([{ node: NODE, status: 'waiting' }])
  })

  it('token sah + transcript di bawah root claude menulis keduanya', async () => {
    const transcript = join(claudeRoot, '-Users-x', 'session.jsonl')
    mkdirSync(join(claudeRoot, '-Users-x'), { recursive: true })
    writeFileSync(transcript, '{}\n')
    const res = mockRes()
    const d = deps()
    await agentStatusRoute(
      mockReq(
        { hook_event_name: 'UserPromptSubmit', transcript_path: transcript },
        { [NODE_TOKEN_HEADER]: TOKEN }
      ),
      res, URL_FOR(NODE), { strictAuth: true, deps: d }
    )
    expect(res.statusCode).toBe(204)
    expect(d.writes.status).toEqual([{ node: NODE, status: 'working' }])
    expect(d.writes.transcript).toEqual([{ node: NODE, path: transcript }])
  })
})

describe('strict auth NYALA — transcript_path harus di dalam root yang diizinkan', () => {
  const withToken = (body: unknown) => mockReq(body, { [NODE_TOKEN_HEADER]: TOKEN })

  /** The path is dropped, the hook is not: the verified node keeps its status badge. */
  async function expectRejected(path: string): Promise<void> {
    const res = mockRes()
    const d = deps()
    await agentStatusRoute(
      withToken({ hook_event_name: 'Stop', transcript_path: path }),
      res, URL_FOR(NODE), { strictAuth: true, deps: d }
    )
    expect(res.statusCode).toBe(204)
    expect(d.writes).toEqual({ status: [{ node: NODE, status: 'waiting' }], transcript: [] })
  }

  it('menolak traversal `..` bahkan bila hasil akhirnya di dalam root', async () => {
    // Dirangkai sebagai string, bukan `join`: `join` menormalkan `..` sebelum guard melihatnya.
    await expectRejected(`${claudeRoot}/-a/../session.jsonl`)
  })

  it('menolak path absolut di luar root', async () => {
    await expectRejected(join(tmpdir(), 'wt-outside', 'session.jsonl'))
  })

  it('menolak path relatif', async () => {
    await expectRejected('session.jsonl')
  })

  it('menolak symlink yang menunjuk keluar root', async () => {
    const outside = join(mkdtempSync(join(tmpdir(), 'wt-outside-')), 'secret.jsonl')
    writeFileSync(outside, '{}\n')
    const link = join(claudeRoot, 'escape.jsonl')
    symlinkSync(outside, link)
    await expectRejected(link)
  })

  it('menolak path yang lebih panjang dari batas', async () => {
    await expectRejected(join(claudeRoot, 'x'.repeat(TRANSCRIPT_PATH_MAX)))
  })

  it('menerima transcript di bawah dataDir() juga', async () => {
    const transcript = join(process.env.WEBTERM_DATA_DIR!, 'notes.jsonl')
    mkdirSync(process.env.WEBTERM_DATA_DIR!, { recursive: true })
    writeFileSync(transcript, '{}\n')
    const res = mockRes()
    const d = deps()
    await agentStatusRoute(
      withToken({ hook_event_name: 'Stop', transcript_path: transcript }),
      res, URL_FOR(NODE), { strictAuth: true, deps: d }
    )
    expect(res.statusCode).toBe(204)
    expect(d.writes.transcript).toEqual([{ node: NODE, path: transcript }])
  })

  it('menerima path yang belum ada selama berada di dalam root', async () => {
    const res = mockRes()
    const d = deps()
    const transcript = join(claudeRoot, '-future', 'not-yet.jsonl')
    await agentStatusRoute(
      withToken({ hook_event_name: 'Stop', transcript_path: transcript }),
      res, URL_FOR(NODE), { strictAuth: true, deps: d }
    )
    expect(res.statusCode).toBe(204)
  })
})

// ---------------------------------------------------------------------------------------------
// IKATAN TOKEN→NODE. Sebelum ini sebuah token node yang SAH bisa dipakai untuk node mana pun:
// `?node=` sepenuhnya dari query string, dan yang diperiksa hanya "token ini pernah dicetak?".
describe('ikatan token→node — tanpa syarat, juga saat strict MATI', () => {
  const VICTIM = 'node-victim-1'
  const VICTIM_URL = URL_FOR(VICTIM)
  const victimToken = nodeToken(VICTIM)

  it('token sendiri + node sendiri menulis status seperti biasa', async () => {
    const res = mockRes()
    const d = deps()
    await agentStatusRoute(
      mockReq({ hook_event_name: 'Stop' }, { [TOKEN_HEADER]: TOKEN }),
      res, URL_FOR(NODE), { strictAuth: false, deps: d }
    )
    expect(res.statusCode).toBe(204)
    expect(d.writes.status).toEqual([{ node: NODE, status: 'waiting' }])
  })

  it('token sendiri + node korban ditolak 403 dan TIDAK menulis apa pun', async () => {
    for (const header of [TOKEN_HEADER, NODE_TOKEN_HEADER]) {
      const res = mockRes()
      const d = deps()
      await agentStatusRoute(
        mockReq(
          { hook_event_name: 'Stop', transcript_path: '/tmp/x.jsonl' },
          { [header]: TOKEN }
        ),
        res, VICTIM_URL, { strictAuth: false, deps: d }
      )
      expect(res.statusCode).toBe(403)
      expect(JSON.parse(res.body)).toEqual({ error: 'node token does not match node' })
      expect(d.writes).toEqual({ status: [], transcript: [] })
    }
  })

  it('token node korban sendiri tetap boleh menulis node korban (bukan yang dilarang)', async () => {
    const res = mockRes()
    const d = deps()
    await agentStatusRoute(
      mockReq({ hook_event_name: 'Stop' }, { [TOKEN_HEADER]: victimToken }),
      res, VICTIM_URL, { strictAuth: false, deps: d }
    )
    expect(res.statusCode).toBe(204)
    expect(d.writes.status).toEqual([{ node: VICTIM, status: 'waiting' }])
  })

  it('root token boleh bertindak untuk node mana pun', async () => {
    for (const url of [URL_FOR(NODE), VICTIM_URL]) {
      const res = mockRes()
      const d = deps()
      await agentStatusRoute(
        mockReq({ hook_event_name: 'Stop' }, { [TOKEN_HEADER]: 'root-transport-token' }),
        res, url, { strictAuth: false, deps: d }
      )
      expect(res.statusCode).toBe(204)
      expect(d.writes.status).toHaveLength(1)
    }
  })

  it('tanpa token / token asing: perilaku lama tidak berubah (fail-open)', async () => {
    const cases: Record<string, string>[] = [{}, { [TOKEN_HEADER]: 'unknown' }]
    for (const headers of cases) {
      const res = mockRes()
      const d = deps()
      await agentStatusRoute(
        mockReq({ hook_event_name: 'Stop' }, headers),
        res, VICTIM_URL, { strictAuth: false, deps: d }
      )
      expect(res.statusCode).toBe(204)
      expect(d.writes.status).toEqual([{ node: VICTIM, status: 'waiting' }])
    }
  })

  it('token yang sudah di-revoke tidak lagi mengikat ke node mana pun', async () => {
    const revoked = nodeToken('node-revoked-1')
    forgetNodeToken('node-revoked-1')
    const res = mockRes()
    const d = deps()
    await agentStatusRoute(
      mockReq({ hook_event_name: 'Stop' }, { [TOKEN_HEADER]: revoked }),
      res, VICTIM_URL, { strictAuth: false, deps: d }
    )
    // Bukan lagi identitas node: jatuh ke jalur "token asing" yang fail-open.
    expect(res.statusCode).toBe(204)
    expect(d.writes.status).toEqual([{ node: VICTIM, status: 'waiting' }])
  })

  it('strict auth tetap bekerja: token sendiri lolos, token node lain untuk node ini 403', async () => {
    const own = mockRes()
    const ownDeps = deps()
    await agentStatusRoute(
      mockReq(
        { hook_event_name: 'Stop' },
        { [TOKEN_HEADER]: TOKEN, [NODE_TOKEN_HEADER]: TOKEN }
      ),
      own, URL_FOR(NODE), { strictAuth: true, deps: ownDeps }
    )
    expect(own.statusCode).toBe(204)
    expect(ownDeps.writes.status).toEqual([{ node: NODE, status: 'waiting' }])

    const foreign = mockRes()
    const foreignDeps = deps()
    await agentStatusRoute(
      mockReq(
        { hook_event_name: 'Stop' },
        { [TOKEN_HEADER]: victimToken, [NODE_TOKEN_HEADER]: victimToken }
      ),
      foreign, URL_FOR(NODE), { strictAuth: true, deps: foreignDeps }
    )
    expect(foreign.statusCode).toBe(403)
    expect(foreignDeps.writes).toEqual({ status: [], transcript: [] })
  })
})

// Route ini bisa dijangkau token node mana pun, jadi body-nya harus berbatas: dulu body utuh
// ditampung lebih dulu baru diparse, sehingga satu POST raksasa cukup untuk menekan server.
describe('batas body hook', () => {
  it('body chunked di atas cap tidak lagi 413: dijawab 200 truncated, tanpa field palsu dari sampah', async () => {
    const res = mockRes()
    const d = deps()
    const half = 'x'.repeat(MAX_HOOK_BODY_BYTES / 2)
    const handled = await agentStatusRoute(
      // Dua potongan yang masing-masing masih di bawah cap: hanya akumulasi yang menembusnya.
      mockChunkedReq([half, half, 'x'.repeat(1024)]),
      res,
      URL_FOR(NODE),
      { strictAuth: false, deps: d }
    )
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ truncated: true })
    expect(d.writes).toEqual({ status: [], transcript: [] })
  })

  // Hanya status yang diperiksa tidak bisa membedakan "tolak SAAT streaming" dari "tampung dulu,
  // baru tolak". Pembaca berbatas melepas listener 'data' begitu cap terlampaui (0 listener);
  // pembaca yang menampung tanpa batas menyisakan 1 listener sampai 'end'.
  it('melepas listener stream begitu cap terlampaui', async () => {
    const res = mockRes()
    const d = deps()
    const req = new EventEmitter() as unknown as IncomingMessage
    Object.assign(req, { method: 'POST', headers: {}, resume() {} })
    const listenersAtOverflow: number[] = []
    process.nextTick(() => {
      req.emit('data', Buffer.alloc(MAX_HOOK_BODY_BYTES + 1)) // satu chunk sudah di atas cap
      listenersAtOverflow.push(req.listenerCount('data'))
      req.emit('data', Buffer.alloc(16))
      req.emit('end')
    })
    const handled = await agentStatusRoute(req, res, URL_FOR(NODE), { strictAuth: false, deps: d })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(listenersAtOverflow).toEqual([0])
    expect(d.writes).toEqual({ status: [], transcript: [] })
  })

  it('menerima body tepat di bawah cap seperti biasa', async () => {
    const res = mockRes()
    const d = deps()
    const body = JSON.stringify({ hook_event_name: 'Stop', pad: 'x'.repeat(MAX_HOOK_BODY_BYTES / 2) })
    await agentStatusRoute(mockReq(body), res, URL_FOR(NODE), { strictAuth: false, deps: d })
    expect(res.statusCode).toBe(204)
    expect(d.writes.status).toEqual([{ node: NODE, status: 'waiting' }])
  })
})

describe('transcriptPathAllowed', () => {
  it('menghormati root yang di-inject dan menolak segmen `..`', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-allow-'))
    expect(transcriptPathAllowed(join(root, 'a.jsonl'), [root])).toBe(true)
    expect(transcriptPathAllowed(join(root, '..foo.jsonl'), [root])).toBe(true)
    expect(transcriptPathAllowed(join(root, '..', 'a.jsonl'), [root])).toBe(false)
    expect(transcriptPathAllowed(join(tmpdir(), 'a.jsonl'), [root])).toBe(false)
  })
})

describe('context-link tidak tersentuh', () => {
  it('route agent-status mengembalikan false untuk path context-link, bahkan saat strict', async () => {
    const res = mockRes()
    const handled = await agentStatusRoute(
      mockReq({}, {}), res,
      new URL('http://127.0.0.1:8700/api/context-link?node=x'),
      { strictAuth: true, deps: deps() }
    )
    expect(handled).toBe(false)
    expect(res.statusCode).toBe(0)
  })

  it('tabel route (routes/control.routes.ts) tetap men-dispatch context-link seperti sebelumnya', async () => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const src = readFileSync(fileURLToPath(new URL('./routes/control.routes.ts', import.meta.url)), 'utf8')
    expect(src).toContain('agentStatusRoute(c.req, c.res, c.url)')
    expect(src).toContain('contextLinkRoute(c.req, c.res, c.url)')
    const route = readFileSync(
      fileURLToPath(new URL('./contextLinkApi.ts', import.meta.url)),
      'utf8'
    )
    expect(route).toContain("url.pathname !== '/api/context-link'")
  })
})

describe('STRICT_HOOK_AUTH dibaca dari env saat modul dimuat', () => {
  it('on by default with no env (data-209-1); only exactly `0` turns it off', async () => {
    vi.resetModules()
    delete process.env.WEBTERM_STRICT_HOOK_AUTH
    expect((await import('./agentStatusApi')).STRICT_HOOK_AUTH).toBe(true)
    for (const [raw, want] of [['0', false], ['off', true], ['1', true]] as const) {
      vi.resetModules()
      process.env.WEBTERM_STRICT_HOOK_AUTH = raw
      expect(`${raw}: ${(await import('./agentStatusApi')).STRICT_HOOK_AUTH}`).toBe(`${raw}: ${want}`)
    }
    delete process.env.WEBTERM_STRICT_HOOK_AUTH
  })
})

describe('Senses producer (F1-d)', () => {
  it('records hook.<Event>: trusted with the node token, untrusted without', async () => {
    const seen: SenseEvent[] = []
    const off = eventBus.subscribe('hook.*', (e) => { seen.push(e) })
    const d = deps({ workspaceFor: () => ({ id: 'w', name: 'w', bridges: [], nodes: [{ id: NODE, kind: 'agent', title: 'Claude' }] }) as unknown as Workspace })
    await agentStatusRoute(mockReq({ hook_event_name: 'Stop' }, { [NODE_TOKEN_HEADER]: TOKEN }), mockRes(), URL_FOR(NODE), { strictAuth: false, deps: d })
    await agentStatusRoute(mockReq({ hook_event_name: 'Stop' }, { [NODE_TOKEN_HEADER]: TOKEN }), mockRes(), URL_FOR(NODE), { strictAuth: false, deps: deps() }) // on no board: no row
    await agentStatusRoute(mockReq({ hook_event_name: 'UserPromptSubmit', prompt: 'secret plan '.repeat(50) }), mockRes(), URL_FOR(NODE), { strictAuth: false, deps: d })
    off()
    expect(seen.map((e) => [e.kind, e.trust, e.nodeId])).toEqual([
      ['hook.Stop', 'trusted', NODE],
      ['hook.UserPromptSubmit', 'untrusted', NODE],
    ])
    expect((seen[0].payload as { status?: string }).status).toBe('waiting')
    expect(String((seen[1].payload as { preview?: string }).preview).length).toBeLessThanOrEqual(121)
  })
})
