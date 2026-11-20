// Policy (docs/decisions/credential-proxy.md §5a): no Claude child env or launch script ever holds a real
// credential, and the subprocess scrub is never switched on. Every composer runs with a poisoned parent env.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dataDir = mkdtempSync(join(tmpdir(), 'wt-cpenv-'))
process.env.WEBTERM_DATA_DIR = dataDir // db.ts / providerDir must never touch the real data dir

const { scrubAgentEnv, SCRUB_VAR } = await import('../agentEnv')
const { agentChatEnv } = await import('../agentChat/agentChat.env')
const { claudeChildEnv } = await import('../central/runtime/claudeOptions')
const { scrubExecEnv } = await import('../central/agents/execRunner')
const { activeProviderEnv, claudeEnv, saveProvider } = await import('../claudeProvider/claudeProvider.store')
const { wrapClaudeLaunch } = await import('../claudeProvider/claudeProvider.launch')
const { ptyEnv } = await import('../ptyShell')
const { TmuxSupervisor } = await import('../ptySupervisor')
const { setProxyEndpointSource } = await import('./credentialProxy.env')

const PROXY = { url: 'http://127.0.0.1:41999', token: 'wtp_placeholder-test-only' } // test-only
const POISON = { // test-only: none of these values may appear in any output
  ANTHROPIC_API_KEY: 'sk-ant-REAL-test-only-key', ANTHROPIC_AUTH_TOKEN: 'REAL-test-only-bearer',
  ANTHROPIC_CUSTOM_HEADERS: 'X-Gateway-Key: REAL-test-only-header',
}
const CARD_SECRET = 'sk-ant-CARD-REAL-test-only-secret' // test-only
/** Credential-shaped vars allowed to pass the composers untouched, each with its reason (docs §2). */
const CREDENTIAL_EXCEPTIONS: ReadonlyArray<{ name: string; reason: string }> = [
  { name: 'CLAUDE_CODE_OAUTH_TOKEN', reason: 'OAuth bearer for the subscription endpoint, not API-key shaped; out of the proxy scope' },
]
const EXCEPTION_NAMES = CREDENTIAL_EXCEPTIONS.map((e) => e.name)
const POISON_VALUES = [...Object.values(POISON), CARD_SECRET, 'REAL-test-only-header']
const PARENT: NodeJS.ProcessEnv = {
  PATH: '/usr/bin:/bin', HOME: '/home/test', ...POISON, [SCRUB_VAR]: '1',
  ANTHROPIC_BASE_URL: 'https://real-gateway.example.test', ANTHROPIC_MODEL: 'm', // test-only
  CLAUDE_CODE_OAUTH_TOKEN: 'oauth-test-only', // the one exception
}

const thrown = (fn: () => unknown): string => { try { fn() } catch (e) { return (e as Error).message } return 'did not throw' }

function expectClean(env: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(env)) {
    if (EXCEPTION_NAMES.includes(k)) continue
    for (const p of POISON_VALUES) expect(`${k}=${v}`.includes(p)).toBe(false)
  }
  expect(['1', 'true'].includes(String(env[SCRUB_VAR]))).toBe(false)
  expect(Boolean(env[SCRUB_VAR])).toBe(false)
  expect(env.ANTHROPIC_AUTH_TOKEN).toBe(undefined)
  expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe(undefined)
  if (env.ANTHROPIC_API_KEY !== undefined) expect([env.ANTHROPIC_API_KEY, env.ANTHROPIC_BASE_URL]).toEqual([PROXY.token, PROXY.url])
}

beforeAll(() => setProxyEndpointSource(() => PROXY))
afterAll(() => { setProxyEndpointSource(() => null); rmSync(dataDir, { recursive: true, force: true }) })

describe('no real credential in any Claude child env (login card + poisoned server env)', () => {
  test('activeProviderEnv / claudeEnv / claudeChildEnv', () => {
    const pe = activeProviderEnv(undefined, PARENT)
    expectClean({ ...pe.set })
    expect(pe.unset).toEqual(expect.arrayContaining(['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_CUSTOM_HEADERS', SCRUB_VAR]))
    expectClean(claudeChildEnv(PARENT))
    expectClean(claudeEnv(claudeChildEnv(PARENT)))
  })
  test('scrubAgentEnv / scrubExecEnv', () => {
    expectClean(scrubAgentEnv(PARENT))
    expectClean(scrubExecEnv(PARENT, {}))
  })
  test('agentChatEnv', () => {
    expectClean(agentChatEnv({ nodeId: 'n', port: 1, parentEnv: PARENT, provider: activeProviderEnv(undefined, PARENT) }))
  })
  test('ptyEnv (PTY base and tmux server) strips every credential', () => {
    const env = ptyEnv(PARENT, { interactive: false, strip: new Set() })
    for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_CUSTOM_HEADERS', SCRUB_VAR]) expect(k in env).toBe(false)
  })
  test('TmuxSupervisor.env (server env inherited by every pane)', () => {
    const saved = { ...process.env }
    try {
      Object.assign(process.env, PARENT)
      const env = (new TmuxSupervisor('/tmp/st/none.sock') as unknown as { env(i: boolean): Record<string, string> }).env(false)
      for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_CUSTOM_HEADERS', SCRUB_VAR]) expect(k in env).toBe(false)
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
      Object.assign(process.env, saved)
    }
  })
  test('launch script of a key card and of a login card with a server-env key holds only the placeholder', () => {
    saveProvider({ mode: 'apiKey' }, CARD_SECRET)
    const launchDir = join(dataDir, 'launch')
    wrapClaudeLaunch('claude', activeProviderEnv(undefined, PARENT), '/bin/sh', launchDir)
    saveProvider({ mode: 'login' }, undefined)
    wrapClaudeLaunch('claude', activeProviderEnv(undefined, PARENT), '/bin/sh', launchDir)
    const scripts = readdirSync(launchDir).map((f) => readFileSync(join(launchDir, f), 'utf8'))
    expect(scripts.length).toBe(2)
    for (const text of scripts) {
      for (const p of POISON_VALUES) expect(text.includes(p)).toBe(false)
      expect(text).toContain(PROXY.token)
      expect(/export CLAUDE_CODE_SUBPROCESS_ENV_SCRUB/.test(text)).toBe(false)
    }
  })
  test('a key card without a running proxy fails closed instead of using the real key', () => {
    setProxyEndpointSource(() => null)
    try {
      saveProvider({ mode: 'apiKey' }, CARD_SECRET)
      expect(thrown(() => activeProviderEnv(undefined, PARENT))).toBe('credential_proxy_unavailable')
      expect(thrown(() => scrubAgentEnv(PARENT))).toBe('credential_proxy_unavailable')
    } finally {
      setProxyEndpointSource(() => PROXY)
    }
  })
})
