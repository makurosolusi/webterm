// Policy: one list of provider env names (agentEnv PROVIDER_ENV_ALLOWLIST) decides what reaches every Claude
// child, from (a) server env / .env, (b) the Provider card, (c) nothing. All values are test-only fakes.
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROVIDER_ENV_ALLOWLIST } from './agentEnv'
import { agentChatEnv } from './agentChat/agentChat.env'
import { claudeChildEnv } from './central/runtime/claudeOptions'
import { scrubExecEnv, type ExecHandle, type ExecSpec } from './central/agents/execRunner'
import { probeClaudeLaunch, type RunFn } from './claudeLauncher/claudeLaunch.probe'
import { providerEnv, type ProviderEnv } from './claudeProvider/claudeProvider.model'
import { claudeEnv, saveProvider } from './claudeProvider/claudeProvider.store'
import { createFileSecretStore, type SecretStore } from './envSecrets.store'
import { PTY_KEEP_FROM_DOTENV } from './dotenvFiles'
import { cleanEnv } from './nameGen'
import { ptyEnv } from './ptyShell'
import { createAgentSpawner } from './spawn/agentSpawn'
import { resolveProfileLaunch } from '../shared/claudeLaunch/claudeLaunch.profiles'

const SERVER = { // test-only
  PATH: '/usr/bin:/bin', HOME: '/home/test',
  ANTHROPIC_BASE_URL: 'https://env-proxy.example.test', ANTHROPIC_AUTH_TOKEN: 'env-token-test-only',
  ANTHROPIC_MODEL: 'env-model', ANTHROPIC_DEFAULT_OPUS_MODEL: 'env-opus', ANTHROPIC_DEFAULT_SONNET_MODEL: 'env-sonnet',
  ANTHROPIC_DEFAULT_HAIKU_MODEL: 'env-haiku', ANTHROPIC_SMALL_FAST_MODEL: 'env-fast', ANTHROPIC_CUSTOM_HEADERS: 'X-Test: 1',
  ANTHROPIC_UNLISTED: 'drop', WEBTERM_TOKEN: 'root-test-only', WEBTERM_NODE_ID: 'parent', OPENAI_API_KEY: 'sk-openai-test-only',
  CLAUDE_CODE_OAUTH_TOKEN: 'oauth-test-only', CAP: 'wcap_test-only',
}
const CARD_SECRET = 'card-secret-test-only'
const CARD_CONFIG = { mode: 'custom' as const, baseUrl: 'https://card-proxy.example.test', credential: 'authToken' as const }
const CARD: ProviderEnv = providerEnv(CARD_CONFIG, CARD_SECRET)
const NONE: ProviderEnv = { set: {}, unset: [] }
const FORBIDDEN = /^(WEBTERM_|NODETERM_|OPENAI_|CLAUDE_CODE_OAUTH|ANTHROPIC_UNLISTED$)/
/** Terminals inherit the user's shell env on purpose; only the root token and the parent identity are dropped. */
const SHELL_FORBIDDEN = /^WEBTERM_TOKEN$/
const LISTED = new Set(PROVIDER_ENV_ALLOWLIST)

const HERE = dirname(fileURLToPath(import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'wt-penv-'))
const cardStore: SecretStore = createFileSecretStore(join(dir, 'card'))
const emptyStore: SecretStore = createFileSecretStore(join(dir, 'empty'))
saveProvider(CARD_CONFIG, CARD_SECRET, cardStore)
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function workerEnv(server: NodeJS.ProcessEnv, pe: ProviderEnv): NodeJS.ProcessEnv {
  const specs: ExecSpec[] = []
  const exec = (spec: ExecSpec): ExecHandle => { specs.push(spec); return { pid: 1, done: new Promise(() => {}), tail: () => '', kill: () => {} } }
  const s = createAgentSpawner({ exec, providerEnv: () => pe, ancestors: () => [], registerSpawn: () => {}, record: () => {}, onPtyExit: () => {} })
  void s.spawn({ door: 'routine', mode: 'headless', parent: 'routine:r1', cwd: '/tmp/wt', prompt: 'go', headless: { env: server } })
  return scrubExecEnv(specs[0]?.env, specs[0]?.overrides)
}

type Build = ((server: NodeJS.ProcessEnv, card: boolean) => Record<string, string | undefined>) & { shell?: true }
const shell = (b: Build): Build => Object.assign(b, { shell: true as const })
const applyCard = (env: Record<string, string>, card: boolean): Record<string, string> => claudeEnv(env, card ? cardStore : emptyStore)
const PATHS: Record<string, Build> = {
  terminal: shell((s, c) => applyCard(ptyEnv(s, { interactive: true, strip: new Set() }), c)),
  agentChat: shell((s, c) => agentChatEnv({ nodeId: 'n', port: 1, parentEnv: s, provider: c ? CARD : NONE })),
  centralTurn: (s, c) => applyCard(claudeChildEnv(s), c),
  worker: (s, c) => workerEnv(s, c ? CARD : NONE),
}

describe('provider env reaches every Claude child path', () => {
  for (const [path, build] of Object.entries(PATHS)) {
    test(`${path}: server-env proxy, URL, token and model vars arrive; forbidden never`, () => {
      const env = build(SERVER, false)
      for (const name of PROVIDER_ENV_ALLOWLIST) if (name in SERVER) expect(env[name] === SERVER[name as keyof typeof SERVER]).toBe(true)
      expect(Object.keys(env).filter((k) => (build.shell ? SHELL_FORBIDDEN : FORBIDDEN).test(k))).toEqual([])
      expect(env.WEBTERM_NODE_ID).not.toBe('parent')
      if (path !== 'terminal') expect(Object.values(env).some((v) => v?.startsWith('wcap_'))).toBe(false)
    })
    test(`${path}: the Provider card beats server env`, () => {
      const env = build(SERVER, true)
      expect(env.ANTHROPIC_BASE_URL).toBe('https://card-proxy.example.test')
      expect(env.ANTHROPIC_AUTH_TOKEN === CARD_SECRET).toBe(true)
      for (const name of ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_CUSTOM_HEADERS']) expect(name in env).toBe(false)
      expect(env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe('1')
    })
    test(`${path}: nothing set adds no ANTHROPIC_* var`, () => {
      const env = build({ PATH: '/usr/bin', HOME: '/h' }, false)
      expect(Object.keys(env).filter((k) => k.startsWith('ANTHROPIC_'))).toEqual([])
    })
  }

  test('central and worker children carry only listed ANTHROPIC_* names, with the scrub on', () => {
    for (const env of [claudeChildEnv(SERVER), workerEnv(SERVER, NONE)]) {
      expect(Object.keys(env).filter((k) => k.startsWith('ANTHROPIC_') && !LISTED.has(k))).toEqual([])
      expect(env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe('1')
    }
  })

  test('.env model vars reach terminals; other .env keys stay stripped', () => {
    const strip = new Set(['ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_MODEL', 'DB_PASSWORD'])
    const env = ptyEnv({ ...SERVER, DB_PASSWORD: 'x' }, { interactive: false, strip, keep: PTY_KEEP_FROM_DOTENV })
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('env-sonnet')
    expect(env.ANTHROPIC_MODEL).toBe('env-model')
    expect('DB_PASSWORD' in env).toBe(false)
  })

  test('nameGen cleanEnv: server env proxy arrives, card wins when saved', () => {
    const saved = { ...process.env }
    try {
      process.env.WEBTERM_DATA_DIR = join(dir, 'data')
      Object.assign(process.env, { ANTHROPIC_BASE_URL: SERVER.ANTHROPIC_BASE_URL, ANTHROPIC_DEFAULT_OPUS_MODEL: 'env-opus' })
      expect(cleanEnv().ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('env-opus')
      saveProvider(CARD_CONFIG, CARD_SECRET, createFileSecretStore(join(dir, 'data', 'claude-provider')))
      const env = cleanEnv()
      expect(env.ANTHROPIC_BASE_URL).toBe('https://card-proxy.example.test')
      expect('ANTHROPIC_DEFAULT_OPUS_MODEL' in env).toBe(false)
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
      Object.assign(process.env, saved)
    }
  })
})

describe('readiness probe with a server-env proxy', () => {
  const launch = resolveProfileLaunch({ claudeLaunchProfiles: [{ id: 'p', name: 'P', command: '' }], defaultClaudeProfileId: 'p', centralClaudeProfileId: '' })
  const notLoggedIn: RunFn = async () => ({ code: 1, stdout: '{"loggedIn":false,"authMethod":"none"}', timedOut: false })
  const login = { mode: 'login', ready: true }

  test('URL plus token in the child env counts as signed in without a login', async () => {
    const r = await probeClaudeLaunch(launch, { env: claudeChildEnv(SERVER), run: notLoggedIn, onPath: () => true, provider: login })
    expect(r.ok).toBe(true)
  })
  test('URL without a token still needs the login', async () => {
    const r = await probeClaudeLaunch(launch, { env: claudeChildEnv({ PATH: '/bin', ANTHROPIC_BASE_URL: 'https://x.test' }), run: notLoggedIn, onPath: () => true, provider: login })
    expect(r).toMatchObject({ ok: false, failed: 'auth_failed' })
  })
  test('nothing set: /login behaviour unchanged', async () => {
    const r = await probeClaudeLaunch(launch, { env: claudeChildEnv({ PATH: '/bin' }), run: notLoggedIn, onPath: () => true, provider: login })
    expect(r).toMatchObject({ ok: false, failed: 'auth_failed' })
  })
})

describe('one list, one builder per launch path (source policy)', () => {
  const src = (p: string): string => readFileSync(join(HERE, p), 'utf8')
  test('helpers, probes and git commit message use the shared builders', () => {
    expect(src('central/context/claudeStructured.ts')).toContain('claudeEnv(claudeChildEnv(process.env))')
    expect(src('central/runtime/claudeRuntime.ts')).toContain('claudeEnv({ ...claudeChildEnv(')
    for (const f of ['centralChatHealth.ts', 'doctor.runtime.ts', 'claudeLauncher/claudeLauncher.api.ts']) expect(src(f)).toContain('claudeChildEnv(')
    expect(src('gitScm.ts')).toMatch(/askClaude[\s\S]*env: cleanEnv\(\)/)
  })
  test('no other source file lists the provider model vars', () => {
    const files: string[] = []
    const walk = (d: string): void => {
      for (const n of readdirSync(d)) {
        const p = join(d, n)
        if (statSync(p).isDirectory()) walk(p)
        else if (/\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n)) files.push(p)
      }
    }
    walk(join(HERE, '..'))
    const offenders = files.filter((f) => !f.endsWith('/agentEnv.ts') && /'ANTHROPIC_DEFAULT_(OPUS|SONNET|HAIKU)_MODEL'|\['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'/.test(readFileSync(f, 'utf8')))
    expect(offenders).toEqual([])
  })
})
