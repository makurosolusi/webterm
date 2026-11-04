// Bun-only (api.ts pulls bun:sqlite via ../db). The sensor families through the REAL router: GETs
// answer 200 for a workspace, and the UI-only POSTs keep their uiOnlyDenial (node token -> 403).
import { test, expect, afterAll } from 'bun:test'
import http from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'wt-sensors-'))
process.env.WEBTERM_DATA_DIR = root // before ../api -> ../db opens
process.env.HOME = root // test-only: nothing may land in the real home dir
const { handleApi } = await import('../api')
const { db } = await import('../db')
const { nodeToken } = await import('../hooksTokens')
// Agent PTYs carry their node token as the transport token (WEBTERM_TOKEN, sessions.ts).
const { TOKEN_HEADER } = await import('../auth')

const cwd = mkdtempSync(join(root, 'ws-'))
writeFileSync(join(cwd, 'package.json'), JSON.stringify({ scripts: { build: 'echo hi' } }))
const ws = db.create('sensors', cwd)
const token = nodeToken('node-sensors-1')

const server = http.createServer((req, res) => { if (!handleApi(req, res)) { res.statusCode = 404; res.end() } })
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
const port = (server.address() as { port: number }).port
afterAll(() => { server.close() })

async function call(path: string, init?: RequestInit): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, init)
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

test('GET /api/ports -> 200 {ports}', async () => {
  const r = await call(`/api/ports?workspace=${ws.id}`)
  expect(r.status).toBe(200)
  expect(Array.isArray(r.body.ports)).toBe(true)
})

test('GET /api/problems -> 200 with paged problems', async () => {
  const r = await call(`/api/problems?workspace=${ws.id}`)
  expect(r.status).toBe(200)
  expect(r.body.total).toBe(0)
  expect(r.body.problems).toEqual([])
})

test('GET /api/tasks -> 200 listing the workspace scripts', async () => {
  const r = await call(`/api/tasks?workspace=${ws.id}`)
  expect(r.status).toBe(200)
  const tasks = r.body.tasks as { name: string }[]
  expect(tasks.some((t) => t.name.includes('build'))).toBe(true)
})

for (const path of ['/api/problems/run', '/api/problems/stop', '/api/problems/fix', '/api/tasks/run']) {
  test(`POST ${path} with a node token -> 403 (UI only)`, async () => {
    const r = await call(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [TOKEN_HEADER]: token },
      body: JSON.stringify({ workspace: ws.id, task: 'x', node: 'node-sensors-1', to: 'node-sensors-1' }),
    })
    expect(r.status).toBe(403)
    expect(String(r.body.error)).toMatch(/^agent_cannot_run_/)
  })
}
