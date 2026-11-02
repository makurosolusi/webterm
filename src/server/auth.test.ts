import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CAPABILITY_HEADER,
  DEFAULT_HOST,
  TOKEN_HEADER,
  authorize,
  authorizeRequest,
  isControlPath,
  isLoopbackHost,
  isNodeTokenPath,
  requiresToken,
  resolveToken,
  sameOrigin,
  tokensMatch,
  writeTokenToEnv,
} from './auth'
import { CapabilityStore } from './control/capabilities'

const SELF = 'webterm.test:8700'
const ROOT = 'root-s3cret'
const NODE = 'node-token-aaaa'
const CAP = 'wcap_header-only-token'
const ORIGIN_HEADERS = { host: SELF, origin: `http://${SELF}` }
/** Stand-in for hooks.ts `isValidNodeToken`: only NODE is a live node token. */
const isNodeToken = (t: string) => t === NODE

/** Stand-in for `capabilityStore.verify(...) !== undefined`: only CAP is live. */
const isCapabilityToken = (t: string) => t === CAP

/** One request through the composed gate, defaults to the same-origin headers. */
function gate(pathname: string, over: Partial<Parameters<typeof authorizeRequest>[0]> = {}): boolean {
  return authorizeRequest({
    headers: ORIGIN_HEADERS,
    expectedToken: ROOT,
    pathname,
    isNodeToken,
    isCapabilityToken,
    ...over,
  })
}

/**
 * Root-only families added in P4. A node token lives on disk in every agent PTY, so any of these
 * paths reaching `isNodeTokenPath` lets one session pause projects or launch workers.
 */
const ROOT_ONLY_PATHS = [
  '/api/central/portfolio',
  '/api/orchestrator/run',
  '/api/memory/export',
  '/api/memory/rebuild',
  '/api/channels/telegram/bindings',
] as const

describe('sameOrigin', () => {
  it('accepts an Origin whose host matches the request Host', () => {
    expect(sameOrigin({ host: SELF, origin: `http://${SELF}` })).toBe(true)
  })
  it('accepts https on the same host:port (proto is not part of the check)', () => {
    expect(sameOrigin({ host: SELF, origin: `https://${SELF}` })).toBe(true)
  })
  it('rejects a different port on the same host', () => {
    expect(sameOrigin({ host: SELF, origin: 'http://webterm.test:8701' })).toBe(false)
  })
  it('rejects a different host on the same port', () => {
    expect(sameOrigin({ host: SELF, origin: 'http://evil.example:8700' })).toBe(false)
  })
  it('rejects the hostile-page case: 127.0.0.1 server dialled from a web page', () => {
    expect(sameOrigin({ host: '127.0.0.1:8700', origin: 'https://evil.example' })).toBe(false)
  })
  it('rejects Origin: null (sandboxed frame / opaque redirect)', () => {
    expect(sameOrigin({ host: SELF, origin: 'null' })).toBe(false)
  })
  it('rejects a malformed Origin instead of throwing', () => {
    expect(sameOrigin({ host: SELF, origin: 'not a url' })).toBe(false)
  })
  it('allows an absent Origin — non-browser clients (curl, CLI, tests)', () => {
    expect(sameOrigin({ host: SELF })).toBe(true)
  })
  it('rejects an absent Origin when the browser itself reports cross-site', () => {
    expect(sameOrigin({ host: SELF, 'sec-fetch-site': 'cross-site' })).toBe(false)
    expect(sameOrigin({ host: SELF, 'sec-fetch-site': 'same-site' })).toBe(false)
    expect(sameOrigin({ host: SELF, 'sec-fetch-site': 'same-origin' })).toBe(true)
  })
  it('reads the first value when a header arrives repeated', () => {
    expect(sameOrigin({ host: [SELF], origin: [`http://${SELF}`] })).toBe(true)
  })
})

describe('isLoopbackHost / requiresToken', () => {
  it('treats the three loopback spellings as loopback', () => {
    for (const h of ['127.0.0.1', 'localhost', '::1']) {
      expect(isLoopbackHost(h)).toBe(true)
      expect(requiresToken(h)).toBe(false)
    }
  })
  it('treats wildcards and LAN addresses as reachable from outside', () => {
    for (const h of ['0.0.0.0', '::', '192.168.1.20', 'webterm.local']) {
      expect(isLoopbackHost(h)).toBe(false)
      expect(requiresToken(h)).toBe(true)
    }
  })
  it('defaults to loopback', () => {
    expect(isLoopbackHost(DEFAULT_HOST)).toBe(true)
  })
})

describe('resolveToken', () => {
  it('allows loopback with no token (the default dev loop)', () => {
    expect(resolveToken('127.0.0.1', undefined)).toBeUndefined()
    expect(resolveToken('127.0.0.1', '   ')).toBeUndefined()
  })
  it('refuses to start on a non-loopback host with no token, naming the env var', () => {
    expect(() => resolveToken('0.0.0.0', undefined)).toThrow(/WEBTERM_TOKEN/)
    expect(() => resolveToken('0.0.0.0', '')).toThrow(/WEBTERM_TOKEN/)
  })
  it('trims and keeps a configured token', () => {
    expect(resolveToken('0.0.0.0', ' s3cret ')).toBe('s3cret')
  })
  it('never puts the token value in the refusal message', () => {
    // The throw path has no token, but assert the host-only shape so a future edit cannot
    // start interpolating secrets into a message that lands in logs.
    expect(() => resolveToken('10.0.0.5', '')).toThrow(/10\.0\.0\.5/)
  })
})

describe('writeTokenToEnv', () => {
  // This suite runs in the same process as every other test file's helpers, so put the real
  // value back no matter what. Tokens below are obvious fakes, injected here.
  const saved = process.env.WEBTERM_TOKEN
  const restore = () => {
    if (saved === undefined) delete process.env.WEBTERM_TOKEN
    else process.env.WEBTERM_TOKEN = saved
  }
  beforeEach(restore)
  afterEach(restore)

  it('replaces a padded raw value with the exact form the server enforces', () => {
    process.env.WEBTERM_TOKEN = ' fake-token-not-real \n'
    const enforced = resolveToken('0.0.0.0', process.env.WEBTERM_TOKEN)
    writeTokenToEnv(enforced)
    // The whole point: what a child expands from $WEBTERM_TOKEN now passes authorize().
    expect(process.env.WEBTERM_TOKEN).toBe(enforced)
    expect(tokensMatch(enforced, process.env.WEBTERM_TOKEN)).toBe(true)
  })

  it('unsets the var when no token is enforced, instead of leaving whitespace behind', () => {
    process.env.WEBTERM_TOKEN = '   '
    writeTokenToEnv(resolveToken('127.0.0.1', process.env.WEBTERM_TOKEN))
    expect('WEBTERM_TOKEN' in process.env).toBe(false)
  })

  it('is called in index.ts on the resolved token, before anything can spawn a PTY', () => {
    // index.ts starts a server on import, so it cannot be imported here — assert the wiring
    // from its source instead. Without this the function could be correct and never called.
    const src = fs.readFileSync(path.resolve(__dirname, 'index.ts'), 'utf8')
    expect(src).toMatch(/writeTokenToEnv\(TOKEN\)/)
    expect(src.indexOf('writeTokenToEnv(TOKEN)')).toBeLessThan(src.indexOf('installContextLink('))
  })
})

describe('tokensMatch', () => {
  it('accepts anything when no token is configured', () => {
    expect(tokensMatch(undefined, null)).toBe(true)
    expect(tokensMatch(undefined, 'whatever')).toBe(true)
  })
  it('accepts the right token', () => {
    expect(tokensMatch('s3cret', 's3cret')).toBe(true)
  })
  it('rejects a wrong token of the same length', () => {
    expect(tokensMatch('s3cret', 'S3CRET')).toBe(false)
  })
  it('rejects without throwing when the lengths differ', () => {
    // crypto.timingSafeEqual throws on unequal buffer lengths; the guard must come first.
    expect(() => tokensMatch('s3cret', 'x')).not.toThrow()
    expect(tokensMatch('s3cret', 'x')).toBe(false)
    expect(tokensMatch('s3cret', 's3cret-and-more')).toBe(false)
    expect(tokensMatch('s3cret', '')).toBe(false)
  })
  it('rejects a missing token when one is required', () => {
    expect(tokensMatch('s3cret', null)).toBe(false)
    expect(tokensMatch('s3cret', undefined)).toBe(false)
  })
})

describe('authorize', () => {
  const headers = { host: SELF, origin: `http://${SELF}` }

  it('passes on loopback with no token at all', () => {
    expect(authorize({ headers, expectedToken: undefined })).toBe(true)
  })
  it('fails on a bad origin even when the token is right', () => {
    expect(
      authorize({
        headers: { host: SELF, origin: 'https://evil.example', [TOKEN_HEADER]: 's3cret' },
        expectedToken: 's3cret',
      })
    ).toBe(false)
  })
  it('accepts the token from the header', () => {
    expect(authorize({ headers: { ...headers, [TOKEN_HEADER]: 's3cret' }, expectedToken: 's3cret' })).toBe(true)
  })
  it('accepts the token from the query (the WebSocket handshake has no headers to set)', () => {
    expect(authorize({ headers, expectedToken: 's3cret', queryToken: 's3cret' })).toBe(true)
  })
  it('rejects a wrong or missing token', () => {
    expect(authorize({ headers, expectedToken: 's3cret', queryToken: 'nope' })).toBe(false)
    expect(authorize({ headers, expectedToken: 's3cret' })).toBe(false)
  })
  it('prefers the header over the query so a stale URL cannot downgrade a good request', () => {
    expect(
      authorize({ headers: { ...headers, [TOKEN_HEADER]: 's3cret' }, expectedToken: 's3cret', queryToken: 'nope' })
    ).toBe(true)
  })
})

describe('isNodeTokenPath', () => {
  it('allows exactly the three hook-facing paths', () => {
    expect(isNodeTokenPath('/api/agent-status')).toBe(true)
    expect(isNodeTokenPath('/api/context-link')).toBe(true)
    expect(isNodeTokenPath('/api/control/approve')).toBe(true)
  })
  it('does not allow anything that reaches settings, workspaces, fs, name-gen or the shell', () => {
    for (const p of [
      '/api/settings',
      '/api/workspaces',
      '/api/workspaces/abc/files',
      '/api/fs/read',
      '/api/generate-name',
      '/ws',
      '/api/agent-status/extra',
      '/api/context-link/',
      '/api/control',
      '/api',
      ...ROOT_ONLY_PATHS,
      // Prefix regressions: each family root and a child must stay outside the allowlist too.
      '/api/central',
      '/api/orchestrator',
      '/api/memory',
      '/api/channels',
      '/api/channels/telegram',
    ]) {
      expect(isNodeTokenPath(p)).toBe(false)
    }
  })
})

describe('isNodeTokenPath — source guard', () => {
  // The behavioural tests above only cover the paths someone remembered to list. A future
  // `pathname.startsWith('/api/central')` addition would still pass every other test, so pin the
  // shape of the allowlist itself: exactly one prefix arm, and only the control family.
  const src = fs.readFileSync(path.resolve(__dirname, 'auth.ts'), 'utf8')
  const start = src.indexOf('export function isNodeTokenPath')
  const end = src.indexOf('/** Keluarga control API')
  const body = start === -1 || end === -1 ? '' : src.slice(start, end)

  it('has exactly the three allowlist arms', () => {
    expect(body).toContain("pathname === '/api/agent-status'")
    expect(body).toContain("pathname === '/api/context-link'")
    expect(body).toContain("pathname.startsWith('/api/control/')")
    // One `startsWith` and no other prefix arms: a `startsWith('/api/central')` regression fails.
    expect(body.match(/startsWith\(/g)).toHaveLength(1)
  })

  it('names no privileged family inside the allowlist', () => {
    expect(body).not.toMatch(/\/api\/(central|orchestrator|memory|channels|projects|settings|workspaces|fs)/)
  })

  it('never widens the allowlist from index.ts', () => {
    const index = fs.readFileSync(path.resolve(__dirname, 'index.ts'), 'utf8')
    expect(index).not.toMatch(/isNodeTokenPath\(\s*['"]\/api\/(central|orchestrator|memory|channels)/)
  })
})

describe('authorizeRequest — node token allowlist', () => {
  it('accepts a node token on the allowed paths, from the header', () => {
    expect(gate('/api/agent-status', { headers: { ...ORIGIN_HEADERS, [TOKEN_HEADER]: NODE } })).toBe(true)
    expect(gate('/api/context-link', { headers: { ...ORIGIN_HEADERS, [TOKEN_HEADER]: NODE } })).toBe(true)
    expect(gate('/api/control/approve', { headers: { ...ORIGIN_HEADERS, [TOKEN_HEADER]: NODE } })).toBe(true)
  })
  it('accepts a node token on the allowed paths from the query', () => {
    expect(gate('/api/agent-status', { queryToken: NODE })).toBe(true)
    expect(gate('/api/control/deny', { queryToken: NODE })).toBe(true)
  })
  it('still accepts the root token everywhere it did before', () => {
    for (const p of ['/api/agent-status', '/api/context-link', '/api/settings', '/api/workspaces', '/api/fs/read', '/ws']) {
      expect(gate(p, { headers: { ...ORIGIN_HEADERS, [TOKEN_HEADER]: ROOT } })).toBe(true)
    }
    expect(gate('/api/settings', { queryToken: ROOT })).toBe(true)
  })
  it('rejects a node token on settings, workspaces, fs, generate-name and /ws', () => {
    for (const p of [
      '/api/settings',
      '/api/workspaces',
      '/api/workspaces/abc/files',
      '/api/fs/read',
      '/api/generate-name',
      '/ws',
    ]) {
      expect(gate(p, { headers: { ...ORIGIN_HEADERS, [TOKEN_HEADER]: NODE } })).toBe(false)
      expect(gate(p, { queryToken: NODE })).toBe(false)
    }
  })
  it('rejects an unknown token even on the allowed paths', () => {
    expect(gate('/api/agent-status', { headers: { ...ORIGIN_HEADERS, [TOKEN_HEADER]: 'not-a-node-token' } })).toBe(false)
    expect(gate('/api/agent-status', { queryToken: 'not-a-node-token' })).toBe(false)
    expect(gate('/api/agent-status')).toBe(false)
    expect(gate('/api/agent-status', { headers: { ...ORIGIN_HEADERS, [TOKEN_HEADER]: '' } })).toBe(false)
  })
  it('applies the origin check to the node-token path too', () => {
    const hostile = { host: SELF, origin: 'https://evil.example', [TOKEN_HEADER]: NODE }
    expect(gate('/api/agent-status', { headers: hostile })).toBe(false)
    expect(gate('/api/context-link', { headers: { host: SELF, origin: 'https://evil.example' }, queryToken: NODE })).toBe(
      false
    )
    expect(gate('/api/control/x', { headers: { host: SELF, 'sec-fetch-site': 'cross-site' }, queryToken: NODE })).toBe(
      false
    )
  })
  it('keeps the loopback no-token default working for every path', () => {
    // expectedToken undefined === token-free loopback: nothing to prove, unchanged by this gate.
    expect(gate('/api/settings', { expectedToken: undefined })).toBe(true)
    expect(gate('/ws', { expectedToken: undefined })).toBe(true)
  })
  it('prefers the header over the query, so a stale query cannot open a path', () => {
    // A wrong header must not be rescued by a node token in the query: the header is what the
    // request actually proves.
    expect(
      gate('/api/agent-status', { headers: { ...ORIGIN_HEADERS, [TOKEN_HEADER]: 'wrong' }, queryToken: NODE })
    ).toBe(false)
  })

  it.each(ROOT_ONLY_PATHS)('rejects a node token on %s from header and query', (p) => {
    expect(gate(p, { headers: { ...ORIGIN_HEADERS, [TOKEN_HEADER]: NODE } })).toBe(false)
    expect(gate(p, { queryToken: NODE })).toBe(false)
    // The root token must still reach every one of them: these are root-only, not unreachable.
    expect(gate(p, { headers: { ...ORIGIN_HEADERS, [TOKEN_HEADER]: ROOT } })).toBe(true)
  })
})

describe('isControlPath', () => {
  it('is exactly the /api/control/ family', () => {
    expect(isControlPath('/api/control/spawn')).toBe(true)
    expect(isControlPath('/api/control/nodes')).toBe(true)
    expect(isControlPath('/api/control/')).toBe(true)
    for (const p of ['/api/control', '/api/settings', '/api/workspaces', '/api/agent-status', '/ws', '/']) {
      expect(isControlPath(p)).toBe(false)
    }
  })
})

describe('authorizeRequest — capability tokens (control API only)', () => {
  const withCap = (extra: Record<string, string> = {}) => ({
    ...ORIGIN_HEADERS,
    [CAPABILITY_HEADER]: CAP,
    ...extra,
  })

  it('accepts a valid capability on the control family', () => {
    expect(gate('/api/control/spawn', { headers: withCap() })).toBe(true)
    expect(gate('/api/control/nodes', { headers: withCap() })).toBe(true)
    expect(gate('/api/control/wait', { headers: withCap() })).toBe(true)
  })

  it('never accepts a capability outside the control family', () => {
    for (const p of [
      '/api/settings',
      '/api/workspaces',
      '/api/workspaces/abc/files',
      '/api/fs/read',
      '/api/generate-name',
      '/api/agent-status',
      '/api/context-link',
      '/api/control',
      '/ws',
    ]) {
      expect(gate(p, { headers: withCap() })).toBe(false)
    }
  })

  it('requires same-origin for a capability, even on the control family', () => {
    expect(gate('/api/control/spawn', { headers: { ...withCap(), origin: 'https://evil.example' } })).toBe(false)
    // `Sec-Fetch-Site` is only consulted when Origin is absent (see sameOrigin).
    expect(
      gate('/api/control/spawn', {
        headers: { host: SELF, 'sec-fetch-site': 'cross-site', [CAPABILITY_HEADER]: CAP },
      })
    ).toBe(false)
    expect(gate('/api/control/nodes', { headers: { ...ORIGIN_HEADERS, origin: 'null', [CAPABILITY_HEADER]: CAP } })).toBe(
      false
    )
  })

  it('rejects an unknown wcap and a minted-but-expired wcap', () => {
    expect(gate('/api/control/spawn', { headers: { ...ORIGIN_HEADERS, [CAPABILITY_HEADER]: 'wcap_nope' } })).toBe(false)

    const store = new CapabilityStore()
    const live = store.mint({ verb: 'node.read', resource: '*' }, 0)
    const expired = store.mint({ verb: 'node.read', resource: '*', ttlMs: 1 }, 0)
    const usingStore = (t: string) => store.verify(t, 10_000) !== undefined
    expect(gate('/api/control/nodes', { headers: { ...ORIGIN_HEADERS, [CAPABILITY_HEADER]: live }, isCapabilityToken: usingStore })).toBe(true)
    expect(
      gate('/api/control/nodes', { headers: { ...ORIGIN_HEADERS, [CAPABILITY_HEADER]: expired }, isCapabilityToken: usingStore })
    ).toBe(false)
  })

  it('accepts nothing on the control family without a header (root token still required)', () => {
    expect(gate('/api/control/spawn')).toBe(false)
    expect(gate('/api/control/spawn', { headers: { ...ORIGIN_HEADERS, [CAPABILITY_HEADER]: '' } })).toBe(false)
  })

  it('does not read a capability from the query string', () => {
    expect(gate('/api/control/spawn', { queryToken: CAP })).toBe(false)
    // Even a same-origin request cannot smuggle one in via ?capability= / ?token=.
    const url = new URL(`http://${SELF}/api/control/spawn?capability=${CAP}`)
    expect(
      gate(url.pathname, { queryToken: url.searchParams.get('token') ?? url.searchParams.get('capability') })
    ).toBe(false)
    expect(
      gate('/api/control/spawn', { queryToken: CAP, headers: { ...ORIGIN_HEADERS, [TOKEN_HEADER]: 'wrong' } })
    ).toBe(false)
  })

  it('does not accept a capability sent in x-webterm-token', () => {
    expect(gate('/api/control/spawn', { headers: { ...ORIGIN_HEADERS, [TOKEN_HEADER]: CAP } })).toBe(false)
  })

  it('keeps root and node tokens working on the control family', () => {
    expect(gate('/api/control/spawn', { headers: { ...ORIGIN_HEADERS, [TOKEN_HEADER]: ROOT } })).toBe(true)
    expect(gate('/api/control/spawn', { headers: { ...ORIGIN_HEADERS, [TOKEN_HEADER]: NODE } })).toBe(true)
    expect(gate('/api/control/spawn', { queryToken: NODE })).toBe(true)
  })

  it('keeps root and node behavior byte-identical when no capability validator is injected', () => {
    const nodeOnly = (pathname: string) => gate(pathname, { isCapabilityToken: undefined, headers: withCap() })
    expect(nodeOnly('/api/control/spawn')).toBe(false) // capability not honoured without a validator
    expect(gate('/api/settings', { headers: { ...ORIGIN_HEADERS, [TOKEN_HEADER]: ROOT } })).toBe(true)
    expect(gate('/api/agent-status', { headers: { ...ORIGIN_HEADERS, [TOKEN_HEADER]: NODE } })).toBe(true)
    expect(gate('/ws', { headers: { ...ORIGIN_HEADERS, [TOKEN_HEADER]: NODE } })).toBe(false)
  })

  it.each(ROOT_ONLY_PATHS)('never accepts a capability on %s', (p) => {
    // A capability is minted for control verbs; it must not reach a privileged family even with a
    // same-origin request, and a node token alongside it must not rescue the request.
    expect(gate(p, { headers: withCap() })).toBe(false)
    expect(gate(p, { headers: withCap({ [TOKEN_HEADER]: NODE }) })).toBe(false)
    expect(gate(p, { queryToken: CAP })).toBe(false)
  })
})

describe('index.ts wiring', () => {
  it('passes a capability validator built on capabilityStore.verify', () => {
    const src = fs.readFileSync(path.resolve(__dirname, 'index.ts'), 'utf8')
    expect(src).toMatch(/import \{ capabilityStore \} from '\.\/control\/mount'/)
    expect(src).toMatch(/isCapabilityToken:\s*\(t\)\s*=>\s*capabilityStore\.verify\(t\)\s*!==\s*undefined/)
  })

  it('routes the gate through authorizeRequest + isValidNodeToken for both /api and /ws', () => {
    // index.ts binds a port on import, so assert the wiring from its source (same pattern as the
    // writeTokenToEnv test above).
    const src = fs.readFileSync(path.resolve(__dirname, 'index.ts'), 'utf8')
    expect(src).toMatch(/authorizeRequest\(\{/)
    expect(src).toMatch(/isNodeToken:\s*isValidNodeToken/)
    expect(src).toMatch(/pathname:\s*url\.pathname/)
    // The /ws upgrade shares `allowed`, so it inherits the node path allowlist — and `/ws` is not
    // on that list, which is what the rejection test above pins down.
    expect(src).toMatch(/if \(!allowed\(req, url\)\)/)
  })
})
