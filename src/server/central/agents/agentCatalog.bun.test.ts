// Bun-only (real child processes + fs). Catalog resolution, tiers, argv integrity and env handling.
import { afterAll, describe, expect, it } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CustomAgent } from '../../../shared/customAgent.schema'
import { DEFAULT_SETTINGS, type Settings } from '../../../shared/settings'
import { AGENT_CONFIG } from '../../../shared/workspace'
import { createAgentCatalog } from './agentCatalog'
import { startExec } from './execRunner'
import { createControlGuard } from '../guard/controlGuard'
import { setLevel } from '../guard/levelStore'
import { freshDb, HUMAN, rows, T0 } from '../guard/controlGuard.testutil'
import { type AgentHost, createAgentExecutor } from './agentExecutor'
import { agentReqId } from './agentStore'

const root = mkdtempSync(join(tmpdir(), 'catalog-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
// Prints its argv tail and one env var as JSON, so the test sees exactly what the child received.
const fixture = join(root, 'echo.mjs')
writeFileSync(fixture, 'console.log(JSON.stringify({ argv: process.argv.slice(2), tok: process.env.API_TOKEN ?? null }))\n')
const BUN = process.execPath

const agent = (over: Partial<CustomAgent> = {}): CustomAgent => ({
  id: 'custom:a', label: 'Agent A', launchCmd: '', centralSpawn: true,
  launch: { program: BUN, args: ['--flag'], headlessArgs: [fixture, '{prompt}'], resumeArgs: ['--resume', '{sessionId}'] }, ...over,
})
const catalogOf = (agents: CustomAgent[], over: Partial<Settings> = {}, env: NodeJS.ProcessEnv = {}, denyRoots: string[] = []) =>
  createAgentCatalog({ settings: () => ({ ...DEFAULT_SETTINGS, customAgents: agents, ...over }), env: () => env, denyRoots: () => denyRoots })

describe('builtin kinds', () => {
  it('keep tier R2; claude launches through the default profile; retired CLIs are not kinds', () => {
    const c = createAgentCatalog({ settings: () => ({ ...DEFAULT_SETTINGS, agentLaunchCommands: { claude: 'ignored-legacy' }, claudeLaunchProfiles: [{ id: 'w', name: 'W', command: 'envman -e w --' }], defaultClaudeProfileId: 'w' }) })
    expect(c.resolve('claude')).toMatchObject({ builtin: true, tier: 'R2', launchLine: 'envman -e w -- claude', headlessArgv: null })
    for (const k of ['codex', 'opencode', 'gemini']) expect(c.resolve(k)).toBeNull()
    expect(c.kinds().filter((k) => k.builtin).map((k) => k.id)).toEqual(['claude'])
    expect(c.resolve('claude')?.childEnv()).toEqual({})
  })

  it('unknown ids and prototype names resolve to null', () => {
    const c = catalogOf([])
    for (const k of ['nope', 'toString', '__proto__', 'constructor', '']) expect(c.resolve(k)).toBeNull()
  })
})

describe('custom kinds', () => {
  it('are invisible to central unless centralSpawn is true', () => {
    for (const centralSpawn of [undefined, false]) {
      const c = catalogOf([agent({ centralSpawn })])
      expect(c.resolve('custom:a')).toBeNull()
      expect(c.kinds().some((k) => k.id === 'custom:a')).toBe(false)
    }
  })

  it('resolve at tier R3 with a defHash that tracks the definition', () => {
    const a = catalogOf([agent()]).resolve('custom:a')
    expect(a).toMatchObject({ builtin: false, tier: 'R3' })
    expect(a?.defHash).toMatch(/^[0-9a-f]{12}$/)
    const same = catalogOf([agent()]).resolve('custom:a')?.defHash
    const changed = catalogOf([agent({ launch: { program: BUN, args: ['--other'], headlessArgs: [fixture, '{prompt}'] } })]).resolve('custom:a')?.defHash
    expect(same).toBe(a?.defHash)
    expect(changed).not.toBe(a?.defHash)
  })

  it('quote every PTY argv element and drop those that need a placeholder value', () => {
    const e = catalogOf([agent({ launch: { program: BUN, args: ['a b', "it's", '{prompt}'] } })]).resolve('custom:a')
    expect(e?.launchLine).toBe(`'${BUN}' 'a b' 'it'\\''s'`)
    expect(e?.headlessArgv).toBeNull()
    expect(e?.resumeArgs).toBe(undefined)
  })

  it('expose resumeArgs only when declared', () => {
    expect(catalogOf([agent()]).resolve('custom:a')?.resumeArgs).toEqual(['--resume', '{sessionId}'])
  })

  it('legacy launchCmd / baseAgent entries launch through customLaunchCmd', () => {
    const c = catalogOf([agent({ id: 'custom:own', launch: undefined, launchCmd: 'my-proxy --tui' }), agent({ id: 'custom:base', launch: undefined, baseAgent: 'claude' })], { claudeLaunchProfiles: [{ id: 'w', name: 'W', command: 'claude-work' }], defaultClaudeProfileId: 'w' })
    expect(c.resolve('custom:own')?.launchLine).toBe('my-proxy --tui')
    expect(c.resolve('custom:base')?.launchLine).toBe('claude-work')
    expect(c.resolve('custom:base')?.tier).toBe('R3')
    expect(catalogOf([agent({ id: 'custom:none', launch: undefined })]).resolve('custom:none')).toBeNull()
  })

  it('refuse a program that is missing or lives under a denied root', () => {
    const exe = join(root, 'bin', 'tool'); mkdirSync(join(root, 'bin'))
    writeFileSync(exe, '#!/bin/sh\n'); chmodSync(exe, 0o755)
    const withProgram = (program: string, deny: string[]) => catalogOf([agent({ launch: { program } })], {}, {}, deny).resolve('custom:a')
    expect(withProgram('definitely-not-installed-xyz', [])).toBeNull()
    expect(withProgram(join(root, 'bin', 'absent'), [])).toBeNull()
    expect(withProgram(exe, [root])).toBeNull()
    expect(withProgram(exe, [join(root, 'bin')])).toBeNull()
    expect(withProgram(exe, [])).not.toBeNull()
  })

  it('kinds() lists builtins plus opened customs, with only id/label/builtin/headless', () => {
    const kinds = catalogOf([agent({ label: 'A\u0007gent' }), agent({ id: 'custom:off', centralSpawn: false })]).kinds()
    expect(kinds.filter((k) => k.builtin).map((k) => k.id)).toEqual(Object.keys(AGENT_CONFIG))
    expect(kinds.filter((k) => k.builtin).every((k) => !k.headless)).toBe(true)
    expect(kinds.find((k) => k.id === 'custom:a')).toEqual({ id: 'custom:a', label: 'Agent', builtin: false, headless: true })
    expect(JSON.stringify(kinds)).not.toContain(BUN)
  })
})

describe('headless argv integrity', () => {
  it('delivers a hostile prompt as ONE argv element and runs nothing from it', async () => {
    const cwd = mkdtempSync(join(root, 'cwd-'))
    const prompt = `'; touch X; $(id) \`id\`\n--flag`
    const argv = catalogOf([agent()]).resolve('custom:a')?.headlessArgv?.(prompt) as readonly string[]
    expect(argv).toEqual([BUN, fixture, prompt])
    const out = await startExec({ argv, cwd, env: process.env, timeoutMs: 20_000 }).done
    expect(out.exitCode).toBe(0)
    expect(out.lastEvent?.argv).toEqual([prompt])
    expect(existsSync(join(cwd, 'X'))).toBe(false)
  })
})

describe('env handling', () => {
  const SECRET = 'sekret-value-1234'
  const withEnv = (env: Record<string, string>, source: NodeJS.ProcessEnv) => catalogOf([agent({ env })], {}, source).resolve('custom:a')

  it('resolves ${env:NAME} for the child only and passes literals through', async () => {
    const e = withEnv({ API_TOKEN: '${env:UPSTREAM_TOKEN}', MODE: 'fast' }, { UPSTREAM_TOKEN: SECRET })
    expect(e?.childEnv()).toEqual({ API_TOKEN: SECRET, MODE: 'fast' })
    const cwd = mkdtempSync(join(root, 'cwd-'))
    const out = await startExec({ argv: e?.headlessArgv?.('p') as string[], cwd, env: process.env, overrides: e?.childEnv(), timeoutMs: 20_000 }).done
    expect(out.lastEvent?.tok).toBe(SECRET)
  })

  it('never serialises the secret (entry, kinds, defHash input)', () => {
    const c = catalogOf([agent({ env: { API_TOKEN: '${env:UPSTREAM_TOKEN}' } })], {}, { UPSTREAM_TOKEN: SECRET })
    expect(JSON.stringify(c.resolve('custom:a'))).not.toContain(SECRET)
    expect(JSON.stringify(c.kinds())).not.toContain(SECRET)
  })

  it('skips unset refs and refs to WEBTERM_/NODETERM_ names', () => {
    const e = withEnv({ A_TOKEN: '${env:UNSET_VAR}', B_TOKEN: '${env:WEBTERM_TOKEN}', C_TOKEN: '${env:NODETERM_NODE_ID}' }, { WEBTERM_TOKEN: 'x', NODETERM_NODE_ID: 'y' })
    expect(e?.childEnv()).toEqual({})
  })
})

describe('spawn through the real guard', () => {
  const SECRET = 'sekret-value-5678'
  function setup() {
    const db = freshDb()
    setLevel(db, { scope: 'global', level: 'act_envelope', actor: HUMAN, now: () => T0 })
    const guard = createControlGuard({ db, now: () => T0, env: { WEBTERM_CENTRAL_AGENTS: 'auto' }, random: () => 0 })
    const catalog = catalogOf([agent({ env: { API_TOKEN: '${env:UPSTREAM_TOKEN}' } })], {}, { UPSTREAM_TOKEN: SECRET })
    const opened: string[] = []
    const host: AgentHost = {
      runnerFor: () => 'pty', spawnTier: (k) => catalog.resolve(k)?.tier ?? null, defHashOf: (k) => catalog.resolve(k)?.defHash,
      worktree: async (a) => `/tmp/wt/${a.id}`, initialPrompt: async () => 'go',
      openPty: async (_a, _cwd, nodeId) => { opened.push(nodeId) }, headlessArgv: () => null, send: async () => undefined,
      scrollback: async () => [], closePty: async () => undefined, hasSession: () => false,
    }
    const ex = createAgentExecutor({ db, guard, host, now: () => T0 })
    const spawn = (kind: string, n: number) => ex.spawn({ projectId: 'p1', kind, role: 'worker', title: 't', reqId: agentReqId('p1', `r${n}`), owner: 'central:c1', requireApproval: false })
    return { db, spawn, opened }
  }

  it('rejects an unknown kind before any row, approval or session exists', async () => {
    const s = setup()
    for (const [i, kind] of ['nope', 'custom:ghost', 'toString'].entries()) expect(await s.spawn(kind, i)).toMatchObject({ ok: false, code: 'agent_kind_unknown' })
    expect(rows(s.db, 'SELECT id FROM central_agents')).toHaveLength(0)
    expect(s.opened).toHaveLength(0)
  })

  it('a custom kind always needs approval (R3) and the pending request carries kind + defHash, never the secret', async () => {
    const s = setup()
    const r = await s.spawn('custom:a', 1)
    expect(r).toMatchObject({ ok: false, code: 'approval_required', data: { kind: 'custom:a' } })
    expect(r.data?.defHash).toMatch(/^[0-9a-f]{12}$/)
    expect(s.opened).toHaveLength(0)
    const dump = JSON.stringify([rows(s.db, 'SELECT * FROM central_agents'), rows(s.db, 'SELECT * FROM approval'), rows(s.db, 'SELECT * FROM event'), r])
    expect(dump).not.toContain(SECRET)
    expect(dump).not.toContain('UPSTREAM_TOKEN')
  })

  it('a builtin kind still spawns without approval', async () => {
    const s = setup()
    expect(await s.spawn('claude', 2)).toMatchObject({ ok: true, data: { kind: 'claude' } })
    expect(s.opened).toHaveLength(1)
  })

  it('a retired builtin (opencode, codex) is an unknown kind now', async () => {
    const s = setup()
    for (const [i, kind] of ['opencode', 'codex'].entries()) expect(await s.spawn(kind, 10 + i)).toMatchObject({ ok: false, code: 'agent_kind_unknown' })
    expect(s.opened).toHaveLength(0)
  })
})
