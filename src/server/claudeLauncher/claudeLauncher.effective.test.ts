// What Claude really starts with (GET /api/claude-launch/effective), saving command mode writes the default
// profile (one concept, + boot migration), and a saved approval level flips the auto-approver switch.
import { TEST_UI_COOKIE } from '../uiSession.testutil'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IncomingMessage } from 'node:http'
import type { Database } from 'bun:sqlite'
import { Readable } from 'node:stream'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_SETTINGS } from '../../shared/settings'
import { claudeLaunchRoute, credentialSource, effectiveClaudeLaunch } from './claudeLauncher.api'
import { nodeClaudeLaunch, registerClaudeLaunchSettings, registerDefaultProfileOverride } from './claudeLauncher'
import { handleProviderApi, PROVIDER_PATH } from '../claudeProvider/claudeProvider.api'
import { defaultProfileAfter } from '../claudeProvider/claudeProvider.command'
import { applyApprovalLevelSwitch } from '../policy/policy.approvalLevel'
import { CLASSIFIER_SWITCH_EVENT } from '../policy/policy.classifier'

// test-only fixtures
const PROFILES = [{ id: 'a', name: 'A', command: 'envman -e claude:a -- claude' }, { id: 'c', name: 'C', command: 'claude --model opus' }]
let dir = ''
let prevData: string | undefined
let stored = { ...DEFAULT_SETTINGS, claudeLaunchProfiles: PROFILES }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cl-eff-'))
  prevData = process.env.WEBTERM_DATA_DIR
  process.env.WEBTERM_DATA_DIR = join(dir, 'data')
  stored = { ...DEFAULT_SETTINGS, claudeLaunchProfiles: PROFILES }
  registerClaudeLaunchSettings(() => stored)
})
afterEach(() => {
  process.env.WEBTERM_DATA_DIR = prevData
  registerClaudeLaunchSettings(() => DEFAULT_SETTINGS)
  registerDefaultProfileOverride(() => undefined)
  rmSync(dir, { recursive: true, force: true })
})

const req = (method: string, body = ''): IncomingMessage => Object.assign(Readable.from(body ? [body] : []), {
  method, headers: { host: 'localhost:8700', origin: 'http://localhost:8700', 'sec-fetch-site': 'same-origin', cookie: TEST_UI_COOKIE },
}) as unknown as IncomingMessage
const url = (p: string): URL => new URL(`http://localhost:8700${p}`)

describe('GET /api/claude-launch/effective', () => {
  it('reports the command-mode profile for agents and Central (not the stored default) and its credential', async () => {
    registerDefaultProfileOverride(() => 'a')
    const r = await claudeLaunchRoute(req('GET'), url('/api/claude-launch/effective'), { isNodeToken: () => false, refreshCentral: vi.fn() })
    expect(r?.status).toBe(200)
    expect(r?.body).toMatchObject({
      agents: { profileId: 'a', command: 'envman -e claude:a -- claude' },
      central: { profileId: 'a', source: 'default' },
      deviations: [],
    })
  })

  it("Central's own pick is a deviation", () => {
    stored = { ...stored, centralClaudeProfileId: 'c' }
    expect(effectiveClaudeLaunch({ mode: 'login' }, {})).toMatchObject({
      agents: { profileId: 'default', command: 'claude' },
      central: { profileId: 'c', source: 'central' },
      credential: 'login',
      deviations: [{ who: 'central', profileId: 'c', name: 'C' }],
    })
  })

  it('credential source: card, command, env proxy/key, or login', () => {
    expect(credentialSource('apiKey', {})).toBe('card')
    expect(credentialSource('custom', {})).toBe('card')
    expect(credentialSource('command', {})).toBe('command')
    expect(credentialSource('login', { ANTHROPIC_BASE_URL: 'https://gw', ANTHROPIC_AUTH_TOKEN: 't' })).toBe('env')
    expect(credentialSource('login', { ANTHROPIC_API_KEY: 'k' })).toBe('env')
    expect(credentialSource('login', {})).toBe('login')
  })

  it('agents cannot read it, and only GET is allowed', async () => {
    const agent = { ...req('GET'), headers: { 'x-nodeterm-node-token': 'n' } } as unknown as IncomingMessage
    expect((await claudeLaunchRoute(agent, url('/api/claude-launch/effective'), { isNodeToken: () => true, refreshCentral: vi.fn() }))?.status).toBe(403)
    expect((await claudeLaunchRoute(req('PUT'), url('/api/claude-launch/effective'), { isNodeToken: () => false, refreshCentral: vi.fn() }))?.status).toBe(405)
  })
})

describe('command mode is the default profile', () => {
  it('saving command mode writes the default; leaving it puts Default back; other saves leave it', async () => {
    let def = 'default'
    const deps = { isNodeToken: () => false, sessionsBefore: () => 0, defaults: { get: () => def, set: (id: string) => { def = id } } }
    const put = (body: unknown) => handleProviderApi(req('PUT'), url(PROVIDER_PATH), JSON.stringify(body), deps)
    expect((await put({ mode: 'command', profileId: 'a' })).status).toBe(200)
    expect(def).toBe('a')
    expect((await put({ mode: 'login' })).status).toBe(200)
    expect(def).toBe('default')
    def = 'c' // a default picked on purpose stays when the mode changes
    await put({ mode: 'apiKey' })
    expect(def).toBe('c')
  })

  it('the boot migration is idempotent', () => {
    expect(defaultProfileAfter({ mode: 'login' }, { mode: 'command', profileId: 'a' }, 'default')).toBe('a')
    expect(defaultProfileAfter({ mode: 'login' }, { mode: 'command', profileId: 'a' }, 'a')).toBeNull()
    expect(defaultProfileAfter({ mode: 'login' }, { mode: 'login' }, 'c')).toBeNull()
  })

  it('a node recorded with Default before the migration keeps following command mode', () => {
    stored = { ...stored, defaultClaudeProfileId: 'a' }
    registerDefaultProfileOverride(() => 'a')
    expect(nodeClaudeLaunch('default').profile.id).toBe('a')
    expect(nodeClaudeLaunch('c').profile.id).toBe('c')
    registerDefaultProfileOverride(() => undefined)
    expect(nodeClaudeLaunch('default').profile.id).toBe('default')
  })
})

describe('approval level -> auto-approver switch', () => {
  it('risky turns both on, always both off, never and other patches leave it', () => {
    const append = vi.fn()
    // setClassifierSwitch caches by it and upserts its central_control row (a no-op statement here). test-only
    const ledger = { db: { query: () => ({ run: () => ({ changes: 1 }) }) } as unknown as Database }
    applyApprovalLevelSwitch({ agentApprovalLevel: 'risky' }, ledger, { append })
    applyApprovalLevelSwitch({ agentApprovalLevel: 'always' }, ledger, { append })
    applyApprovalLevelSwitch({ agentApprovalLevel: 'never' }, ledger, { append })
    applyApprovalLevelSwitch({ fontSize: 14 }, ledger, { append })
    applyApprovalLevelSwitch({ agentApprovalLevel: 'risky' }, null, { append }) // ledger off
    expect(append.mock.calls.map((c) => [c[0].kind, c[0].payload])).toEqual([
      [CLASSIFIER_SWITCH_EVENT, { central: true, permissions: true }],
      [CLASSIFIER_SWITCH_EVENT, { central: false, permissions: false }],
    ])
  })
})
