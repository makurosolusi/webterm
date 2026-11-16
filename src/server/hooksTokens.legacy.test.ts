// Rename compatibility: the server ISSUES only `x-webterm-node-token` / `WEBTERM_*` names and still
// ACCEPTS the pre-rename header from agent sessions that were started before the rename.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const dataDir = mkdtempSync(join(tmpdir(), 'webterm-legacy-hdr-'))
process.env.WEBTERM_DATA_DIR = dataDir

import { TOKEN_HEADER } from './auth'
import { nodeTokenHeader, requesterNodeId } from './agentStatusAuth'
import { claudeHeadersPath } from './hooksPaths'
import { writeNodeHeaders } from './hooksSettings'
import { forgetNodeToken, LEGACY_NODE_TOKEN_HEADER, NODE_TOKEN_HEADER, nodeToken, nodeTokenFrom, stateVerified } from './hooksTokens'

afterAll(() => rmSync(dataDir, { recursive: true, force: true }))

const req = (headers: Record<string, string>) => ({ headers }) as unknown as IncomingMessage

describe('node token header rename', () => {
  it('writes only the new header name (plus the transport header) into the node header file', () => {
    const path = writeNodeHeaders('lg-1')
    const text = readFileSync(claudeHeadersPath('lg-1'), 'utf8')
    expect(path).toBe(claudeHeadersPath('lg-1'))
    expect(text).toContain(`${NODE_TOKEN_HEADER}: ${nodeToken('lg-1')}`)
    expect(text).toContain(`${TOKEN_HEADER}: `)
    expect(text.toLowerCase()).not.toContain('nodeterm')
    forgetNodeToken('lg-1')
  })

  it('accepts the legacy header and prefers the new one', () => {
    expect(NODE_TOKEN_HEADER).toBe('x-webterm-node-token')
    expect(LEGACY_NODE_TOKEN_HEADER).toBe('x-nodeterm-node-token')
    const get = (h: Record<string, string>) => nodeTokenFrom((n) => h[n])
    expect(get({ [LEGACY_NODE_TOKEN_HEADER]: 'old' })).toBe('old')
    expect(get({ [LEGACY_NODE_TOKEN_HEADER]: 'old', [NODE_TOKEN_HEADER]: 'new' })).toBe('new')
    expect(get({})).toBeUndefined()
  })

  it('hook auth verifies a token sent under either header name', () => {
    const t = nodeToken('lg-2')
    expect(nodeTokenHeader(req({ [LEGACY_NODE_TOKEN_HEADER]: t }))).toBe(t)
    expect(stateVerified('lg-2', nodeTokenHeader(req({ [NODE_TOKEN_HEADER]: t })))).toBe(true)
    expect(stateVerified('lg-2', nodeTokenHeader(req({ [LEGACY_NODE_TOKEN_HEADER]: t })))).toBe(true)
    expect(requesterNodeId(req({ [LEGACY_NODE_TOKEN_HEADER]: t }))).toBe('lg-2')
    expect(requesterNodeId(req({ [NODE_TOKEN_HEADER]: t }))).toBe('lg-2')
    expect(requesterNodeId(req({ [NODE_TOKEN_HEADER]: 'someone-else' }))).toBeUndefined()
    forgetNodeToken('lg-2')
  })
})
