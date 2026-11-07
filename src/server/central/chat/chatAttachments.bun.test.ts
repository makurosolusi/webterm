// Bun-only (bun:sqlite). Central chat attachments end to end through the HTTP seam: images reach the
// fake `claude` as stream-json image blocks, text files are inlined into the prompt, history keeps a
// reference / name + size only, the image is served back by reference, caps and refusals. Never the
// real CLI; the data dir is a temp dir.
import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { openLedgerDb } from '../../ledger/migration'
import { centralChatRoute, type CentralChatDeps } from '../../centralChatApi'
import type { LedgerRuntime } from '../../ledger/ledgerRuntime'
import { listConversationEvents } from '../conversationStore'
import type { CentralRuntime } from '../runtime/centralRuntime'
import { ClaudeRuntime } from '../runtime/claudeRuntime'
import { OpenCodeRuntime } from '../runtime/opencodeRuntime'
import { createCentralMcpLink } from '../runtime/claudeMcp'
import { captureSource, emitSource, successRecords, writeFakeClaude } from '../runtime/claude.fakeBin'
import { StreamHub } from './streamHub'
import { TurnService } from './turnService'
import { parseAttachments, withFiles } from './chatAttachments'

// test-only fixtures: a 1x1 PNG and the data dir isolation.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const b64 = (s: string | Uint8Array): string => Buffer.from(s).toString('base64')
const dir = mkdtempSync(join(tmpdir(), 'central-attach-'))
const prevDataDir = process.env['WEBTERM_DATA_DIR']
process.env['WEBTERM_DATA_DIR'] = join(dir, 'data')
afterAll(() => {
  if (prevDataDir === undefined) delete process.env['WEBTERM_DATA_DIR']
  else process.env['WEBTERM_DATA_DIR'] = prevDataDir
  rmSync(dir, { recursive: true, force: true })
})

function claude(capture: string): ClaudeRuntime {
  return new ClaudeRuntime({
    executable: writeFakeClaude(dir, captureSource(capture) + emitSource(successRecords())),
    workDir: join(dir, 'work'),
    env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: dir },
    killGraceMs: 50,
    // test-only token: keeps the process capability store out of this test
    mcp: createCentralMcpLink({ dir: join(dir, 'mcp'), port: 1, mint: () => ({ token: 'wcap_test-only', revoke: () => undefined }) }),
  })
}

function setup(runtime: CentralRuntime) {
  const db = openLedgerDb(':memory:')
  const stream = new StreamHub({ replay: (id, after) => listConversationEvents(db, id, after, 500), heartbeatMs: 0 })
  const service = new TurnService({ db, stream, runtime })
  const ledger = { db, mode: 'on', path: ':memory:', ledger: {} } as unknown as LedgerRuntime
  const deps: CentralChatDeps = { ledger, chatEnabled: true, centralEnabled: true, runtimeKind: runtime.kind, service, stream }
  return { db, service, deps }
}

async function call(deps: CentralChatDeps, path: string, body?: unknown) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage
  req.method = body === undefined ? 'GET' : 'POST'
  req.headers = {}
  const chunks: Buffer[] = []
  const headers: Record<string, unknown> = {}
  const res = {
    statusCode: 200, writableEnded: false, setHeader(k: string, v: unknown) { headers[k] = v }, write() {},
    end(c: string | Buffer = '') { chunks.push(Buffer.from(c)); this.writableEnded = true }, on() { return this },
  }
  await centralChatRoute(req, res as unknown as ServerResponse, new URL(path, 'http://x'), deps)
  const raw = Buffer.concat(chunks)
  const json = headers['Content-Type'] === 'application/json' && raw.length ? JSON.parse(raw.toString()) as Record<string, unknown> : {}
  return { status: res.statusCode, headers, raw, json }
}

const MESSAGES = (id = 'central:global') => `/api/central/conversations/${encodeURIComponent(id)}/messages`
const errorOf = (json: Record<string, unknown>) => json['error'] as { code: string; message: string }

describe('parseAttachments (caps and kinds)', () => {
  it('takes a text file and an image, sniffing the image type', () => {
    const r = parseAttachments({ images: [{ mediaType: 'image/jpeg', data: PNG }], files: [{ name: 'a.ts', data: b64('const a = 1\n') }] })
    if ('reason' in r) throw new Error(r.reason)
    expect(r.images[0]?.mediaType).toBe('image/png')
    expect(r.files).toEqual([{ name: 'a.ts', text: 'const a = 1\n', size: 12 }])
  })

  it('refuses a bad media type, a non-image, a binary file and oversize files', () => {
    const reason = (body: Record<string, unknown>) => ('reason' in parseAttachments(body) ? (parseAttachments(body) as { reason: string }).reason : '')
    expect(reason({ images: [{ mediaType: 'image/svg+xml', data: PNG }] })).toContain('PNG, JPEG, GIF or WebP')
    expect(reason({ images: [{ mediaType: 'image/png', data: b64('not an image') }] })).toContain('is not a PNG')
    expect(reason({ files: [{ name: 'x.bin', data: b64(new Uint8Array([0x7f, 0x45, 0x00, 0x01])) }] })).toBe('x.bin is not a UTF-8 text file. Central can read text files and images only.')
    expect(reason({ files: [{ name: 'big.txt', data: b64('a'.repeat(200 * 1024 + 1)) }] })).toBe('big.txt is over 200 KB.')
    const third = b64('a'.repeat(190 * 1024))
    expect(reason({ files: [1, 2, 3].map((n) => ({ name: `${n}.txt`, data: third })) })).toBe('Files are over 500 KB in total.')
    expect(reason({ images: new Array(21).fill({ mediaType: 'image/png', data: PNG }) })).toBe('At most 20 images per message.')
  })

  it('fences a file with more backticks than it holds', () => {
    expect(withFiles('Look', [{ name: 'r.md', text: 'a ```js``` b', size: 1 }])).toBe('Look\n\nAttached file "r.md":\n````\na ```js``` b\n````')
  })
})

describe('send with attachments (claude runtime)', () => {
  it('sends images as stream-json image blocks plus the inlined file, keeps refs in history and serves the image', async () => {
    const capture = join(dir, 'cap-1.json')
    const { service, deps } = setup(claude(capture))
    const sent = await call(deps, MESSAGES(), {
      clientMessageId: 'c1', text: 'What is this?',
      images: [{ mediaType: 'image/png', data: PNG }], files: [{ name: 'notes.txt', data: b64('remember the milk') }],
    })
    expect(sent.status).toBe(202)
    await service.waitFor(String(sent.json['turnId']))

    const child = JSON.parse(readFileSync(capture, 'utf8')) as { argv: string[]; stdin: string }
    expect(child.argv.join(' ')).toContain('--output-format stream-json --input-format stream-json')
    const line = JSON.parse(child.stdin.trim()) as { type: string; message: { role: string; content: Array<Record<string, unknown>> } }
    expect(line.type).toBe('user')
    expect(line.message.content[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } })
    const textBlock = line.message.content[1] as { type: string; text: string }
    expect(textBlock.type).toBe('text')
    expect(textBlock.text).toContain('What is this?')
    expect(textBlock.text).toContain('Attached file "notes.txt":\n```\nremember the milk\n```')

    const history = await call(deps, MESSAGES())
    const human = (history.json['items'] as Array<{ role: string; parts: Array<Record<string, unknown>> }>).find((m) => m.role === 'human')
    const [image, file, text] = human?.parts ?? []
    expect(image).toMatchObject({ type: 'image', mediaType: 'image/png' })
    expect(file).toEqual({ type: 'file', name: 'notes.txt', size: 17 })
    expect(text).toEqual({ type: 'text', text: 'What is this?' })
    expect(JSON.stringify(history.json)).not.toContain(PNG)

    const ref = String(image?.['ref'])
    const served = await call(deps, `${MESSAGES()}?image=${ref}`)
    expect(served.status).toBe(200)
    expect(served.headers['Content-Type']).toBe('image/png')
    expect(served.raw.toString('base64')).toBe(PNG)
    // A reference only resolves inside its own conversation.
    expect((await call(deps, `${MESSAGES('central:chat:other')}?image=${ref}`)).status).toBe(404)
    expect((await call(deps, `${MESSAGES()}?image=../../x`)).status).toBe(404)
  })

  it('sends plain text stdin without images and allows a files-only message', async () => {
    const capture = join(dir, 'cap-2.json')
    const { service, deps } = setup(claude(capture))
    const sent = await call(deps, MESSAGES(), { clientMessageId: 'c2', text: '  ', files: [{ name: 'a.json', data: b64('{"k":1}') }] })
    expect(sent.status).toBe(202)
    await service.waitFor(String(sent.json['turnId']))
    const child = JSON.parse(readFileSync(capture, 'utf8')) as { argv: string[]; stdin: string }
    expect(child.argv).not.toContain('--input-format')
    expect(child.stdin).toBe('Attached file "a.json":\n```\n{"k":1}\n```')
  })

  it('answers 400 invalid_attachment for a refused file, before any turn starts', async () => {
    const { db, deps } = setup(claude(join(dir, 'cap-3.json')))
    const r = await call(deps, MESSAGES(), { clientMessageId: 'c3', text: 'hi', files: [{ name: 'a.png.bin', data: b64(new Uint8Array([0, 1, 2, 3])) }] })
    expect(r.status).toBe(400)
    expect(errorOf(r.json)).toEqual({ code: 'invalid_attachment', message: 'a.png.bin is not a UTF-8 text file. Central can read text files and images only.' })
    expect(db.query('SELECT count(*) AS n FROM central_turn').get()).toEqual({ n: 0 })
  })
})

describe('send with attachments (opencode runtime)', () => {
  it('refuses images clearly instead of dropping them', async () => {
    const { db, deps } = setup(new OpenCodeRuntime({ preflight: async () => ({ ok: true }) }))
    const r = await call(deps, MESSAGES(), { clientMessageId: 'o1', text: 'see', images: [{ mediaType: 'image/png', data: PNG }] })
    expect(r.status).toBe(400)
    expect(errorOf(r.json).code).toBe('images_unsupported')
    expect(errorOf(r.json).message).toContain('Images need the Claude runtime')
    expect(db.query('SELECT count(*) AS n FROM central_message').get()).toEqual({ n: 0 })
  })
})
