import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { AGENT_PROTECTION_PATH, agentProtectionRoute } from './agentSandbox.api'
import { BROWSER_PROFILE_DIRS, SANDBOX_EXCLUDED_COMMANDS, UNSANDBOXED_RETRY_RULE, agentProtection, agentSandboxOn, claudeProtectionSettings } from './agentSandbox'
import { forgetNodeToken, nodeToken } from './hooksTokens'
import { nodeTokenMismatch, requesterNodeId } from './agentStatusAuth'
import { BUILTIN_AGENT_IDS } from '../shared/workspace'

const DIR = '/nonexistent/webterm-data' // test-only: realpath falls back to the literal
// forgetNodeToken removes per-node files under dataDir(): keep that away from the user's data dir.
const ORIGINAL_DATA_DIR = process.env.WEBTERM_DATA_DIR
const TMP_DATA = mkdtempSync(join(tmpdir(), 'webterm-sbx-unit-'))
process.env.WEBTERM_DATA_DIR = TMP_DATA
afterAll(() => {
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.WEBTERM_DATA_DIR
  else process.env.WEBTERM_DATA_DIR = ORIGINAL_DATA_DIR
  rmSync(TMP_DATA, { recursive: true, force: true })
})

type Settings = { permissions: { deny: string[]; ask: string[] }; sandbox?: { enabled: boolean; filesystem: Record<string, string[]>; network: unknown } }

describe('claudeProtectionSettings', () => {
  it('denies Claude file tools on every secret entry, shim edits and .env files', () => {
    const s = claudeProtectionSettings(DIR, { platform: 'darwin', env: {} }) as Settings
    for (const e of ['secrets', 'node-settings', 'webterm.db*', 'ledger.db*', 'channels', 'browser', 'auth.json']) {
      expect(s.permissions.deny).toContain(`Read(/${DIR}/${e})`)
      expect(s.permissions.deny).toContain(`Read(/${DIR}/${e}/**)`)
    }
    expect(s.permissions.deny).toContain(`Edit(/${DIR}/context-links/**)`)
    expect(s.permissions.deny).toContain(`Bash(cat ${DIR}/*)`)
    for (const f of ['.env', '.env.local', '.env.production', '.envrc']) expect(s.permissions.deny).toContain(`Read(**/${f})`)
    // Templates stay readable: no deny rule may match them (deny always beats allow).
    expect(s.permissions.deny).not.toContain('Read(**/.env*)')
    for (const t of ['.env.example', '.env.sample', '.env.template']) expect(s.permissions.deny.some((r) => r.includes(t))).toBe(false)
    // The shims and worktrees must stay readable: agents run the former and work inside the latter.
    expect(s.permissions.deny.some((r) => r.includes('/worktrees') || r === `Read(/${DIR}/context-links/**)`)).toBe(false)
    expect(s.permissions.ask).toEqual([UNSANDBOXED_RETRY_RULE])
  })

  it('on macOS enables the sandbox: whole data dir unreadable except shims/worktrees, secrets unwritable, network unchanged', () => {
    const sandbox = (claudeProtectionSettings(DIR, { platform: 'darwin', env: {} }) as Settings).sandbox!
    expect(sandbox.enabled).toBe(true)
    expect(sandbox.filesystem.denyRead).toEqual([DIR, ...BROWSER_PROFILE_DIRS])
    expect(sandbox.filesystem.allowRead).toEqual([`${DIR}/context-links`, `${DIR}/browser-agent`, `${DIR}/worktrees`])
    expect(sandbox.filesystem.allowWrite).toEqual(['~/'])
    expect(sandbox.filesystem.denyWrite).toEqual(expect.arrayContaining([
      `${DIR}/secrets`, `${DIR}/node-settings`, `${DIR}/context-links`, `${DIR}/webterm.db`, `${DIR}/webterm.db-wal`, `${DIR}/ledger.db-shm`,
    ]))
    // A deny on the whole dir would beat the worktree allow and break agents whose cwd is there.
    expect(sandbox.filesystem.denyWrite).not.toContain(DIR)
    expect(sandbox.filesystem.denyWrite.some((p) => p.includes('worktrees'))).toBe(false)
    expect(sandbox.network).toEqual({ allowedDomains: ['*'], allowLocalBinding: true })
    // Keychain/socket tools run outside the sandbox; docs syntax `x *` matches with or without args.
    expect((sandbox as unknown as { excludedCommands: string[] }).excludedCommands).toEqual(expect.arrayContaining(['gh *', 'docker *', 'brew *', 'op *', 'security *']))
    expect(SANDBOX_EXCLUDED_COMMANDS.every((c) => c.endsWith(' *'))).toBe(true)
  })

  it("opens this node's own header file to its sandbox, and no other node's", () => {
    const own = `${DIR}/node-settings/aaaa.headers`
    const sandbox = (claudeProtectionSettings(DIR, { platform: 'darwin', env: {}, ownHeaders: own }) as Settings).sandbox!
    expect(sandbox.filesystem.allowRead).toContain(own)
    expect(sandbox.filesystem.allowRead.filter((p) => p.includes('node-settings'))).toEqual([own])
    expect(sandbox.filesystem.denyRead).toEqual([DIR, ...BROWSER_PROFILE_DIRS])
  })

  it('walls off the sign-in redirect dir and the browser cookie stores (wt_ui on disk)', () => {
    const s = claudeProtectionSettings(DIR, { platform: 'darwin', env: {} }) as Settings
    expect(s.permissions.deny).toContain(`Read(/${DIR}/run/**)`)
    expect(s.sandbox!.filesystem.denyWrite).toContain(`${DIR}/run`)
    for (const p of ['~/Library/Application Support/Google/Chrome', '~/Library/Application Support/Firefox', '~/Library/Cookies']) {
      expect(s.sandbox!.filesystem.denyRead).toContain(p)
      expect(s.permissions.deny).toContain(`Read(${p}/**)`)
    }
  })

  it('WEBTERM_AGENT_SANDBOX=off drops the sandbox block but keeps the permission rules', () => {
    expect(agentSandboxOn({})).toBe(true)
    expect(agentSandboxOn({ WEBTERM_AGENT_SANDBOX: 'off' })).toBe(false)
    const s = claudeProtectionSettings(DIR, { platform: 'darwin', env: { WEBTERM_AGENT_SANDBOX: 'off' } }) as Settings
    expect(s.sandbox).toBeUndefined()
    expect(s.permissions.deny).toContain(`Read(/${DIR}/secrets/**)`)
  })

  it('off macOS writes no sandbox block (Linux sandbox would cut the shims off from 127.0.0.1)', () => {
    expect((claudeProtectionSettings(DIR, { platform: 'linux', env: {} }) as Settings).sandbox).toBeUndefined()
  })
})

describe('agentProtection', () => {
  it('lists every builtin kind once with a level and English reasons', () => {
    const rows = agentProtection('darwin', {})
    expect(rows.map((r) => r.kind)).toEqual([...BUILTIN_AGENT_IDS])
    for (const r of rows) {
      expect(['protected', 'mitigation']).toContain(r.level)
      expect(r.reasons.length).toBeGreaterThan(0)
      for (const reason of r.reasons) expect(reason).toMatch(/^[\x20-\x7e]+$/)
    }
  })

  it('only sandboxed Claude on macOS claims protected: the API needs a credential the sandbox cannot read (sec-208-1)', () => {
    const level = (p: NodeJS.Platform, k: string) => agentProtection(p, {}).find((r) => r.kind === k)?.level
    expect(level('darwin', 'claude')).toBe('protected')
    expect(agentProtection('darwin', {}).find((r) => r.kind === 'claude')!.reasons.join(' ')).toContain('HttpOnly cookie')
    expect(level('linux', 'claude')).toBe('mitigation')
    const off = agentProtection('darwin', { WEBTERM_AGENT_SANDBOX: 'off' }).find((r) => r.kind === 'claude')!
    expect(off.level).toBe('mitigation')
    expect(off.reasons[0]).toContain('WEBTERM_AGENT_SANDBOX')
    for (const k of ['codex', 'gemini', 'opencode']) expect(level('darwin', k)).toBeUndefined() // plain terminal programs, no row
  })
})

function fakeRes() {
  const headers: Record<string, string> = {}
  const res = {
    statusCode: 0,
    body: '',
    setHeader: (k: string, v: string) => { headers[k.toLowerCase()] = v },
    end: (b: string) => { res.body = b },
  }
  return { res, headers }
}

describe(`GET ${AGENT_PROTECTION_PATH}`, () => {
  it('answers [{kind, level, reasons[]}] as no-store JSON', () => {
    const { res, headers } = fakeRes()
    const handled = agentProtectionRoute({ method: 'GET' } as IncomingMessage, res as unknown as ServerResponse, AGENT_PROTECTION_PATH, 'darwin')
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(headers['cache-control']).toBe('no-store')
    const body = JSON.parse(res.body)
    expect(body).toEqual(agentProtection('darwin'))
    expect(Object.keys(body[0]).sort()).toEqual(['kind', 'level', 'reasons'])
  })

  it('refuses other methods with 405 and ignores other paths', () => {
    const { res } = fakeRes()
    expect(agentProtectionRoute({ method: 'POST' } as IncomingMessage, res as unknown as ServerResponse, AGENT_PROTECTION_PATH)).toBe(true)
    expect(res.statusCode).toBe(405)
    expect(agentProtectionRoute({ method: 'GET' } as IncomingMessage, fakeRes().res as unknown as ServerResponse, '/api/agents')).toBe(false)
  })
})

describe('node token binding', () => {
  it("node A's token proves node A only: it is a mismatch for node B and dies with A", () => {
    const a = nodeToken('sbx-node-a')
    nodeToken('sbx-node-b')
    const req = { headers: { 'x-webterm-token': a } } as unknown as IncomingMessage
    expect(requesterNodeId(req)).toBe('sbx-node-a')
    expect(nodeTokenMismatch(requesterNodeId(req), 'sbx-node-b')).toBe(true)
    expect(nodeTokenMismatch(requesterNodeId(req), 'sbx-node-a')).toBe(false)
    forgetNodeToken('sbx-node-a')
    expect(requesterNodeId(req)).toBeUndefined()
    forgetNodeToken('sbx-node-b')
  })
})
