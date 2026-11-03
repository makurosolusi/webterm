// Pratinjau custom agent: dry-run murni (tanpa spawn), env hanya nama, 400 untuk body rusak.
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'

const spawnSpies = vi.hoisted(() => ({
  spawn: vi.fn(), spawnSync: vi.fn(), exec: vi.fn(), execSync: vi.fn(), execFile: vi.fn(), execFileSync: vi.fn(), fork: vi.fn(),
}))
vi.mock('node:child_process', () => ({ ...spawnSpies, default: spawnSpies }))

import { customAgentsPreviewRoute } from './customAgentsApi'

interface RecordedRes extends ServerResponse { status: number; body: string; json(): unknown }

function recorder(): RecordedRes {
  const res = {
    status: 0,
    body: '',
    headersSent: false,
    setHeader: () => undefined,
    end: (chunk?: string) => { if (chunk) res.body += chunk },
    json: () => JSON.parse(res.body) as unknown,
  }
  Object.defineProperty(res, 'statusCode', { get: () => res.status, set: (v: number) => { res.status = v } })
  return res as unknown as RecordedRes
}

/** Request palsu berbentuk stream Node; `body` dikirim sebagai satu chunk lalu `end`. */
function post(body: string, method = 'POST'): { req: IncomingMessage; res: RecordedRes } {
  const req = new EventEmitter() as unknown as IncomingMessage
  Object.assign(req, { method, headers: {}, resume: () => undefined })
  process.nextTick(() => {
    req.emit('data', Buffer.from(body))
    req.emit('end')
  })
  return { req, res: recorder() }
}

async function preview(body: unknown, exists = (_: string) => true): Promise<RecordedRes> {
  const { req, res } = post(typeof body === 'string' ? body : JSON.stringify(body))
  await customAgentsPreviewRoute(req, res, 'POST', { exists })
  return res
}

const AGENT = {
  id: 'custom:1', label: 'Aider', launchCmd: '',
  launch: { program: 'aider', args: ['--no-auto-commits'] },
  env: { OPENAI_API_KEY: '${env:OPENAI_API_KEY}', MODE: 'plain-literal-value' },
  centralSpawn: true,
}

describe('POST /api/custom-agents/preview', () => {
  it('mengembalikan argv, binaryFound, nama env (tanpa nilai) dan tier tanpa spawn proses', async () => {
    const seen: string[] = []
    const res = await preview({ agent: AGENT }, (bin) => { seen.push(bin); return true })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      argv: ['aider', '--no-auto-commits'], binaryFound: true, envNames: ['OPENAI_API_KEY', 'MODE'], tier: 'R3',
    })
    expect(seen).toEqual(['aider'])
    expect(res.body).not.toContain('plain-literal-value')
    expect(res.body).not.toContain('${env:')
    for (const spy of Object.values(spawnSpies)) expect(spy).not.toHaveBeenCalled()
  })

  it('binaryFound false bila biner tak ada; tier null tanpa centralSpawn', async () => {
    const res = await preview({ agent: { ...AGENT, centralSpawn: false } }, () => false)
    expect(res.json()).toMatchObject({ binaryFound: false, tier: null })
  })

  it('agent tanpa launch: argv kosong, binaryFound null, biner tidak dicek', async () => {
    const exists = vi.fn(() => true)
    const res = await preview({ agent: { id: 'custom:2', label: 'Lama', launchCmd: 'foo --bar' } }, exists)
    expect(res.json()).toEqual({ argv: [], binaryFound: null, envNames: [], tier: null })
    expect(exists).not.toHaveBeenCalled()
  })

  it('400 invalid_agent per field untuk definisi yang ditolak strict (tanpa memantulkan nilai)', async () => {
    const bad = { ...AGENT, launch: { program: 'bash' }, env: { API_TOKEN: 'sk-literal-secret' } }
    const res = await preview({ agent: bad })
    expect(res.statusCode).toBe(400)
    const out = res.json() as { error: string; errors: Array<{ field: string; code: string }> }
    expect(out.error).toBe('invalid_agent')
    expect(out.errors.map((e) => `${e.field}:${e.code}`)).toEqual(
      expect.arrayContaining(['launch.program:forbidden_program', 'env.API_TOKEN:secret_literal'])
    )
    expect(res.body).not.toContain('sk-literal-secret')
  })

  it.each([
    ['JSON rusak', '{nope', 'bad json'],
    ['tanpa agent', '{}', 'agent_required'],
    ['agent bukan objek', '{"agent":"x"}', 'agent_required'],
    ['agent array', '{"agent":[]}', 'agent_required'],
    ['body null', 'null', 'agent_required'],
  ])('400 untuk %s', async (_name, body, error) => {
    const res = await preview(body)
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error })
  })

  it('405 selain POST tanpa membaca body', async () => {
    const res = recorder()
    await customAgentsPreviewRoute(post('', 'GET').req, res, 'GET')
    expect(res.statusCode).toBe(405)
  })
})
