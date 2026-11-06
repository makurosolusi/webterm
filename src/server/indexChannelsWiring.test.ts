// Source-level guard for the one wiring change index.ts needs: the binding API must be reachable
// only AFTER the /api gate, in `routeApp`, which both the dev and the production listener call. index.ts binds a
// port and imports Bun-only modules at top level, so it cannot be imported under vitest; asserting
// on the source is the only cheap way to catch a reordering regression.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
const GATE = 'if (url.pathname.startsWith(API_PREFIX) && !allowed(req, url)) { refuseRequest(res); return true }'
const BINDINGS = 'return telegramHot.handleApi(req, res) || handleApi(req, res)'
const WEBHOOK = 'if (telegramHot.handle(req, res)) return true'

describe('index.ts channel wiring', () => {
  it('gates the binding API in both listeners, always after `allowed`', () => {
    const blocks = source.split(GATE)
    expect(blocks).toHaveLength(2)
    // The bindings call comes before the generic API dispatch (short-circuit `||`), so it owns its path.
    expect(blocks[1]).toContain(BINDINGS)
    expect(source.split('routeApp(req, res, ').length - 1).toBe(2) // dev + prod listener
  })

  it('routes the webhook before the gate (provider secret, not WEBTERM_TOKEN)', () => {
    const blocks = source.split(GATE)
    for (const block of blocks.slice(0, -1)) expect(block).toContain(WEBHOOK)
    // /auth/* hands out the UI session cookie, so it sits before the gate too (routes/auth.routes.ts).
    expect(blocks[0]).toContain('if (uiAuthRoute(req, res, url)) return true')
  })

  it('does not grow a second auth path for the bindings route', () => {
    expect(source.split('telegramHot.handleApi').length - 1).toBe(1) // the single call in routeApp
    expect(source).not.toContain('isNodeTokenPath(' + "'/api/channels")
    expect(source).toContain("import http from 'node:http'")
    expect(source).toContain('http.createServer()')
  })
})
