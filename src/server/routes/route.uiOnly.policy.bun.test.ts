// sec-208-1 lock on the inner human-UI gate (handleApi, behind the outer gate of index.ts): no file
// or workspace route answers a request that carries no credential and no browser fetch metadata (a
// plain curl, an agent shell), and forged browser metadata without the `wt_ui` cookie buys nothing
// over that curl (Lock 2). The signed-in page and the root token still get through, and the
// surfaces agent sessions use (webterm CLI capability bindings, browser skill, context-link, hooks)
// are an explicit allowlist that the gate never touches. Lock 1 (outer gate): boot.zeroenv.bun.test.ts.
import { TEST_UI_COOKIE } from '../uiSession.testutil'
import { apiPathsByFile } from '../apiPaths.testutil'
import { afterAll, describe, expect, test } from 'bun:test'
import http from 'node:http'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dataDir = mkdtempSync(join(tmpdir(), 'wt-uionly-'))
process.env.WEBTERM_DATA_DIR = dataDir // before ../api -> ../db opens
const { API_ROUTES, handleApi } = await import('../api')
const { routeCtx } = await import('./route.core')
const { FS_VERB_METHODS } = await import('../fsApi')
const { TOOL_INDEX } = await import('../cli/cli.registry')
const { authorizeRequest, CAPABILITY_HEADER, isNodeTokenPath, TOKEN_HEADER } = await import('../auth')
const { getTokenState, setTokenState } = await import('../tokenBootstrap')
const { TELEGRAM_WEBHOOK_PATH } = await import('../channels/channelsRuntime')
const { TOKEN_ACCESS_PATH, tokenAccessRoute } = await import('../tokenAccess.api')

/** Route entries wrapped in `uiOnly` (route.uiOnly.ts) or gated the same way in their handler. */
const GATED = ['fs-verbs', 'folder-picker', 'workspaces', 'git-info', 'workspace-create', 'generate-name', 'agent-chat', 'claude-view']
/** Answer without the webterm page: the channel webhook (own provider secret, routed before /api)
 *  and the node-token surfaces (`isNodeTokenPath`) the CLI, browser skill and hooks call. */
const ALLOWLIST = ['/api/agent-status', '/api/context-link', '/api/control/browser/navigate', '/api/tools', '/api/tools/x']
const ROOT_TOKEN = 'root-token-test-only-0123456789abcdef' // test-only
const UI = { 'sec-fetch-site': 'same-origin', cookie: TEST_UI_COOKIE }

const folder = mkdtempSync(join(tmpdir(), 'wt-uionly-files-'))
writeFileSync(join(folder, 'a.txt'), 'hello')
const q = new URLSearchParams({ path: folder, root: folder, dir: folder, name: 'b.txt', q: 'a' }).toString()
const body = JSON.stringify({ path: join(folder, 'a.txt'), content: 'pwned', paths: [folder], name: 'w', cwd: folder, parent: folder })
const PROBES: [string, string][] = [
  ...FS_VERB_METHODS.map(([verb, m]) => [m, `/api/fs/${verb}?${q}`] as [string, string]),
  ['GET', `/api/fs?${q}`], ['POST', '/api/fs'],
  ['GET', '/api/workspaces'], ['POST', '/api/workspaces'], ['PUT', '/api/workspaces/w1'], ['DELETE', '/api/workspaces/w1'],
  ['GET', '/api/active'], ['PUT', '/api/active'],
  ['POST', '/api/git/info'],
  ['GET', '/api/workspace-create/defaults'], ['POST', '/api/workspace-create/project'],
  ['POST', '/api/generate-name'],
  ['GET', '/api/agent-chat/n1/stream'], ['GET', '/api/agent-chat/n1/history'], ['POST', '/api/agent-chat/n1/send'],
  ['POST', '/api/agent-chat/n1/interrupt'], ['POST', '/api/agent-chat/n1/permission'], ['POST', '/api/agent-chat/n1/mode'],
  ['POST', '/api/claude-view/n1'],
]

const SRC = join(import.meta.dirname, '..', '..')
const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH']
const pathOf = (url: string): string => new URL(url, 'http://x').pathname
// Same order as index.ts routeApp after the outer gate.
const server = http.createServer((req, res) => {
  if (tokenAccessRoute(req, res, pathOf(req.url ?? '/'), join(dataDir, 'secrets')) || handleApi(req, res)) return
  res.statusCode = 404
  res.end()
})
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
const port = (server.address() as { port: number }).port
afterAll(() => { server.close(); setTokenState({ token: undefined, source: 'none', created: false }) })

function call(method: string, path: string, headers: Record<string, string> = {}, payload = body): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      let text = ''
      res.on('data', (c) => { text += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }))
    })
    req.on('error', reject)
    req.end(method === 'GET' || method === 'DELETE' ? undefined : payload)
  })
}

/** Gated route entries whose `match` claims `path` (a fake ctx; no handler runs). */
function gatedFor(path: string): string[] {
  return matching(path, 'GET').filter((n) => GATED.includes(n))
}
function matching(path: string, method: string): string[] {
  const c = routeCtx({ url: path, method, headers: {} } as http.IncomingMessage, {} as http.ServerResponse, async () => {})
  return API_ROUTES.filter((r) => r.match?.(c)).map((r) => r.name)
}
/** Browser fetch metadata a non-browser caller can forge: same-origin Sec-Fetch-Site plus a matching Origin. */
const forged = (): Record<string, string> => ({ 'sec-fetch-site': 'same-origin', origin: `http://127.0.0.1:${port}` })
/** Source files that hold a human-UI gate (`uiOnly` wrapper or a direct `uiOnlyDenial` call), with their /api paths. */
const GATED_FILES = [...apiPathsByFile()].filter(([f]) =>
  f.startsWith('server/') && !/approvalAuth\.ts$|route\.uiOnly\.ts$/.test(f) && /uiOnlyDenial\(|uiOnly\(/.test(readFileSync(join(SRC, f), 'utf8')))

describe('file and workspace routes are human-UI only', () => {
  test('every gated name is in the route table and has a match', () => {
    for (const name of GATED) expect(typeof API_ROUTES.find((r) => r.name === name)?.match).toBe('function')
  })

  test('no credential and no fetch metadata -> 403 on every probe', async () => {
    const answered: string[] = []
    for (const [m, p] of PROBES) {
      const r = await call(m, p)
      if (r.status !== 403) answered.push(`${m} ${p.split('?')[0]} -> ${r.status}`)
    }
    expect(answered).toEqual([])
  })

  test('the webterm page (same-origin fetch) still lists a folder, the board and git info', async () => {
    const list = await call('GET', `/api/fs/list?${q}`, UI)
    expect(list.status).toBe(200)
    expect(list.body).toContain('a.txt')
    expect((await call('GET', '/api/workspaces', UI)).status).toBe(200)
    expect((await call('POST', '/api/git/info', UI)).status).toBe(200)
    // Folder picker "New Folder": POST {parent, name} on the same gated path.
    const made = await call('POST', '/api/fs', UI, JSON.stringify({ parent: folder, name: 'made-by-ui' }))
    expect(made.status).toBe(200)
    expect(JSON.parse(made.body)).toEqual({ path: join(folder, 'made-by-ui') })
    expect((await call('POST', '/api/fs', UI, 'not json')).status).toBe(400)
  })

  // sec-208-10: name-gen spends model tokens on a node's terminal; a GET was fireable by any <img>.
  // Only malformed bodies are sent from the page here: a valid one would spawn claude.
  test('generate-name is POST only and validates its body', async () => {
    expect((await call('GET', '/api/generate-name?node=n1', UI)).status).toBe(404)
    expect((await call('POST', '/api/generate-name', UI, '{}')).status).toBe(400)
    expect((await call('POST', '/api/generate-name', UI, 'not json')).status).toBe(400)
    expect((await call('POST', '/api/generate-name', UI, JSON.stringify({ node: 'x'.repeat(8192) }))).status).toBe(413)
  })

  // Only malformed bodies / unknown nodes from the page: a valid switch would end a real session.
  test('claude-view answers the page: bad body 400, unknown node 404', async () => {
    expect((await call('POST', '/api/claude-view/n1', UI, '{}')).status).toBe(400)
    expect((await call('POST', '/api/claude-view/n1', UI, JSON.stringify({ to: 'chat' }))).status).toBe(404)
  })

  test('a cross-site page is refused even with fetch metadata', async () => {
    expect((await call('GET', `/api/fs/list?${q}`, { 'sec-fetch-site': 'cross-site', origin: 'https://evil.test' })).status).toBe(403)
  })

  test('the root token (operator script) still gets through without fetch metadata', async () => {
    setTokenState({ token: ROOT_TOKEN, source: 'file', created: false })
    try {
      expect((await call('GET', `/api/fs/list?${q}`, { [TOKEN_HEADER]: ROOT_TOKEN })).status).toBe(200)
      expect((await call('GET', `/api/fs/list?${q}`, { [TOKEN_HEADER]: 'x'.repeat(ROOT_TOKEN.length) })).status).toBe(403)
    } finally {
      setTokenState({ token: undefined, source: 'none', created: false })
    }
  })
})

// Lock 2: every gated source file, every path it names, every method. A forged same-origin request
// without the cookie must answer exactly what a plain curl gets (routes that check their runtime
// before the gate answer 503 both ways), so the cookie, not the metadata, is what opens the gate.
describe('forged browser metadata without the wt_ui cookie opens nothing', () => {
  test('the walk finds the gated source files', () => {
    expect(GATED_FILES.length).toBeGreaterThan(20)
  })

  test('every human-UI route answers a forged same-origin request like a plain curl', async () => {
    const opened: string[] = []
    let refused = 0
    for (const [file, paths] of GATED_FILES) {
      for (const p of paths) {
        for (const m of METHODS) {
          const plain = (await call(m, p, {}, '{}')).status
          const fake = (await call(m, p, forged(), '{}')).status
          if (fake === 403) refused++
          if (fake !== plain) opened.push(`${file}: ${m} ${p} curl=${plain} forged=${fake}`)
        }
      }
    }
    expect(opened).toEqual([])
    expect(refused).toBeGreaterThan(50)
  }, 60_000)

  test('POST /api/settings/token/enable refuses a forged same-origin request', async () => {
    const r = await call('POST', `${TOKEN_ACCESS_PATH}/enable`, forged(), '{}')
    expect(r.status).toBe(403)
    expect(getTokenState().token).toBe(undefined) // nothing was installed
  })

  test('every routed entry is reached by some harvested /api path, so the walks miss no family', () => {
    const paths = [...new Set([...apiPathsByFile().values()].flat())]
    const unreached = API_ROUTES.filter((r) => r.match && !paths.some((p) => METHODS.some((m) => matching(p, m).includes(r.name))))
    expect(unreached.map((r) => r.name)).toEqual([])
  })
})

// The board's writes speak for the human (approve, request changes, auto-done): an agent holds a node
// token, and the outer gate (index.ts `allowed`) must not take it here, nor any capability token.
const CENTRAL_BOARD_PATHS = ['/api/central/tasks', '/api/central/tasks/t1', '/api/central/tasks/t1/approve', '/api/central/tasks/t1/changes', '/api/central/tasks/t1/cancel', '/api/central/tasks/t1/retry', '/api/central/work-settings', '/api/central/goals', '/api/central/goals/p1/activate', '/api/central/goals/p1/abandon', '/api/central/checkin-settings', '/api/central/reminders', '/api/central/reminders/r1/cancel',
  '/api/central/state', '/api/central/memory/m1/confirm', '/api/central/memory/m1/forget', '/api/central/context', '/api/central/turns/t1/context',
  '/api/central/health/summary', '/api/central/health/findings', '/api/central/health/scan', '/api/central/health/findings/f1/dismiss', '/api/central/health/findings/f1/reopen']

describe('the Central task board refuses agent credentials', () => {
  const opens = (pathname: string, headers: Record<string, string>): boolean => authorizeRequest({ headers, expectedToken: ROOT_TOKEN, pathname, isNodeToken: () => true, isCapabilityToken: () => true })

  test('a valid node token or capability token opens no board path; the root token does', () => {
    for (const p of CENTRAL_BOARD_PATHS) {
      expect(`${p}: ${isNodeTokenPath(p)}`).toBe(`${p}: false`)
      expect(`${p}: ${opens(p, { [TOKEN_HEADER]: 'node-token' })}`).toBe(`${p}: false`) // test-only
      expect(`${p}: ${opens(p, { [CAPABILITY_HEADER]: 'wcap_test' })}`).toBe(`${p}: false`) // test-only
      expect(`${p}: ${opens(p, { [TOKEN_HEADER]: ROOT_TOKEN })}`).toBe(`${p}: true`)
    }
  })

  test('no webterm CLI capability binding dispatches into the board', () => {
    const bound = TOOL_INDEX.list().flatMap((c) => (c.route ? [c.route.path] : []))
    expect(bound.filter((p) => /^\/api\/central\/(tasks|goals|work-settings|state|memory|context|turns|checkin-settings|reminders|health)/.test(p))).toEqual([])
  })
})

describe('agent surfaces stay outside the gate', () => {
  test('allowlist: node-token paths and the channel webhook, none claimed by a gated route', () => {
    for (const p of ALLOWLIST) {
      expect(`${p}: ${isNodeTokenPath(p)}`).toBe(`${p}: true`)
      expect(gatedFor(p)).toEqual([])
    }
    expect(TELEGRAM_WEBHOOK_PATH.startsWith('/api/')).toBe(false) // routed before handleApi (index.ts)
  })

  test('no gated route is a node-token path', () => {
    for (const [, p] of PROBES) expect(`${p}: ${isNodeTokenPath(p.split('?')[0] as string)}`).toBe(`${p}: false`)
  })

  test('no webterm CLI capability binding dispatches into a gated route', () => {
    const routes = TOOL_INDEX.list().flatMap((c) => (c.route ? [`${c.route.method} ${c.route.path.replace(/:([A-Za-z]+)/g, 'x')}`] : []))
    expect(routes.length).toBeGreaterThan(0)
    expect(routes.filter((r) => gatedFor(r.split(' ')[1] as string).length > 0)).toEqual([])
  })
})
