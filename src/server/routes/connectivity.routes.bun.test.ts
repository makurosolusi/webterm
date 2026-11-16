// GET /api/connectivity through the REAL router behind the same gate server.main.ts puts on /api:
// refused without a credential, answered with the root token, 503 while no detector runs.
import { afterAll, expect, test } from 'bun:test'
import http from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'wt-conn-'))
process.env.WEBTERM_DATA_DIR = root // before ../api -> ../db opens
process.env.HOME = root // test-only: nothing may land in the real home dir
const { handleApi } = await import('../api')
const { authorizeRequest, TOKEN_HEADER } = await import('../auth')
const { refuseRequest } = await import('../bootWiring')
const { Database } = await import('bun:sqlite')
const { migrate } = await import('../ledger/migration')
const { createConnectivityService } = await import('../connectivity/connectivity.service')
const { createEpisodeStore } = await import('../connectivity/connectivity.store')
const { setActiveConnectivity } = await import('../connectivity/connectivity.runtime')

const TOKEN = 'test-only-root-token'
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x')
  const ok = authorizeRequest({ headers: req.headers, expectedToken: TOKEN, pathname: url.pathname, isNodeToken: () => false })
  if (!ok) return refuseRequest(res)
  if (!handleApi(req, res)) { res.statusCode = 404; res.end() }
})
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
const port = (server.address() as { port: number }).port
afterAll(() => { server.close(); setActiveConnectivity(null) })
const get = (headers: Record<string, string> = {}): Promise<Response> => fetch(`http://127.0.0.1:${port}/api/connectivity`, { headers })

test('refused without a credential, 503 without a detector, 200 with state and episodes', async () => {
  expect((await get()).status).toBe(403) // the /api gate answers 403 (refuseRequest), not 401
  expect((await get({ [TOKEN_HEADER]: 'wrong' })).status).toBe(403)
  setActiveConnectivity(null)
  expect((await get({ [TOKEN_HEADER]: TOKEN })).status).toBe(503)

  const db = new Database(':memory:'); migrate(db)
  const failing = createConnectivityService({
    fetch: async () => { throw new Error('ECONNREFUSED') }, now: () => 5000, baseUrl: () => undefined,
    store: createEpisodeStore(db, () => 5000), log: { warn: () => {}, info: () => {} },
  })
  await failing.tick()
  setActiveConnectivity(failing)
  const res = await get({ [TOKEN_HEADER]: TOKEN })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { state: string; cause: string; scope: string; episodes: { state: string; endedAt: null }[] }
  expect(body).toMatchObject({ state: 'degraded', cause: 'tcp', scope: 'network' })
  expect(body.episodes).toMatchObject([{ state: 'degraded', endedAt: null }])
})
