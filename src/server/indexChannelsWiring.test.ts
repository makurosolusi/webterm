// Source-level guard for the one wiring change index.ts needs: the binding API must be reachable
// only AFTER the /api gate, in both the dev and the production request listener. index.ts binds a
// port and imports Bun-only modules at top level, so it cannot be imported under vitest; asserting
// on the source is the only cheap way to catch a reordering regression.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
const GATE = 'if (url.pathname.startsWith(API_PREFIX) && !allowed(req, url)) return refuseRequest(req, res, HOSTS)'
const BINDINGS = 'if (telegramHot.handleApi(req, res)) return'
const WEBHOOK = 'if (telegramHot.handle(req, res)) return'

describe('index.ts channel wiring', () => {
  it('gates the binding API in both listeners, always after `allowed`', () => {
    const blocks = source.split(GATE)
    expect(blocks).toHaveLength(3)
    for (const block of blocks.slice(1)) {
      expect(block).toContain(BINDINGS)
      // The bindings call comes before the generic API dispatch, so it owns its path.
      expect(block.indexOf(BINDINGS)).toBeLessThan(block.indexOf('if (handleApi(req, res)) return'))
    }
  })

  it('routes the webhook before the gate (provider secret, not WEBTERM_TOKEN)', () => {
    const blocks = source.split(GATE)
    for (const block of blocks.slice(0, -1)) expect(block).toContain(WEBHOOK)
  })

  it('does not grow a second auth path for the bindings route', () => {
    expect(source.split('telegramHot.handleApi').length - 1).toBe(2)
    expect(source).not.toContain('isNodeTokenPath(' + "'/api/channels")
    expect(source).toContain("import http from 'node:http'")
    expect(source).toContain('http.createServer()')
  })
})
