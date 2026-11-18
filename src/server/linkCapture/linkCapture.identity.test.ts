// The limited link-open credential: bound to one node, one route, kept out of env/argv, and useless for anything else.
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { authorizeRequest, isNodeTokenPath, TOKEN_HEADER } from '../auth'
import { LINK_OPEN_PATH, LINK_TOKEN_HEADER } from './linkCapture.config'
import { forgetLinkHeaders, linkCredential, linkCredentialOwner, linkHeadersPath, writeLinkHeaders } from './linkCapture.identity'

process.env.WEBTERM_DATA_DIR = mkdtempSync(join(tmpdir(), 'wt-linkid-'))

const gate = (pathname: string, headers: Record<string, string>) => authorizeRequest({
  headers, expectedToken: 'root-token-test-only', pathname, isNodeToken: () => false, isLinkCredential: (v) => linkCredentialOwner(v) !== undefined, // test-only
})

describe('link credential', () => {
  it('names the node it was issued to', () => {
    expect(linkCredentialOwner(linkCredential('node-1'))).toBe('node-1')
  })

  it('is not transferable: a changed node id, a changed mac, or junk proves nothing', () => {
    const mine = linkCredential('node-1')
    const mac = mine.slice(0, mine.indexOf('.'))
    expect(linkCredentialOwner(`${mac}.node-2`)).toBeUndefined()
    expect(linkCredentialOwner(`${'0'.repeat(mac.length)}.node-1`)).toBeUndefined()
    for (const bad of ['', '.', 'node-1', `${mac}.`, `${mac}.-rf`, `${mac}.../x`, undefined, 42]) expect(linkCredentialOwner(bad)).toBeUndefined()
  })

  it('the header file is 0600, holds only the scoped header, and goes away with the node', () => {
    const path = writeLinkHeaders('node-1')
    expect(path).toBe(linkHeadersPath('node-1'))
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(readFileSync(path, 'utf8')).toBe(`${LINK_TOKEN_HEADER}: ${linkCredential('node-1')}\n`)
    forgetLinkHeaders('node-1')
    expect(() => readFileSync(path)).toThrow()
  })
})

describe('what the credential opens', () => {
  const cred = { [LINK_TOKEN_HEADER]: linkCredential('node-1') }

  it('passes the gate on the link-open route', () => {
    expect(gate(LINK_OPEN_PATH, cred)).toBe(true)
  })

  it.each(['/api/tools', '/api/tools/git.diff', '/api/control/browser/navigate', '/api/control/spawn', '/api/context-link', '/api/agent-status', '/api/workspaces', '/api/fs/read', '/api/settings', '/ws'])(
    'is refused on %s (scope = one route)', (path) => {
      expect(gate(path, cred)).toBe(false)
    })

  it('a forged credential is refused even on its own route', () => {
    expect(gate(LINK_OPEN_PATH, { [LINK_TOKEN_HEADER]: 'deadbeef.node-1' })).toBe(false)
    expect(gate(LINK_OPEN_PATH, {})).toBe(false)
  })

  it('does not ride the node-token header, and agents may reach the route with their node token', () => {
    expect(gate(LINK_OPEN_PATH, { [TOKEN_HEADER]: linkCredential('node-1') })).toBe(false)
    expect(isNodeTokenPath(LINK_OPEN_PATH)).toBe(true)
  })
})
