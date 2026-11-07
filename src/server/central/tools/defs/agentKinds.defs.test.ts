import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../../../../shared/settings'
import { createAgentCatalog } from '../../agents/agentCatalog'
import { openFixture, seedPortfolio } from '../../centralTestFixture.testutil'
import { createRegistry } from '../toolRegistry'
import { ALLOW_ALL_GUARD, execTool } from '../toolExec'
import { AGENTS_FLAG } from './agent.defs'
import { createAgentKindsDef } from './agentKinds.defs'

const T0 = 1_700_000_000_000
const SECRET = 'sekret-value-9999'

function setup() {
  const f = openFixture(); seedPortfolio(f.db)
  const catalog = createAgentCatalog({
    env: () => ({ UPSTREAM_TOKEN: SECRET }),
    settings: () => ({ ...DEFAULT_SETTINGS, customAgents: [
      { id: 'custom:open', label: 'Open', launchCmd: '', centralSpawn: true, env: { API_TOKEN: '${env:UPSTREAM_TOKEN}' }, launch: { program: process.execPath, args: ['--secret-arg'], headlessArgs: ['{prompt}'] } },
      { id: 'custom:closed', label: 'Closed', launchCmd: 'x' },
    ] }),
  })
  const registry = createRegistry(); registry.register(createAgentKindsDef(catalog))
  const run = (mode: string, args: Record<string, unknown> = { projectId: 'p1' }) =>
    execTool({ db: f.db, registry, guard: ALLOW_ALL_GUARD, maxTier: 'R0', conversationId: 'global', now: () => T0, env: { [AGENTS_FLAG]: mode } }, 'agent.kinds', args)
  return { f, registry, run }
}

describe('agent.kinds', () => {
  it('is an R0 tool that registers no agent.define companion', () => {
    const { registry } = setup()
    expect(registry.get('agent.kinds')?.tier).toBe('R0')
    expect(registry.get('agent.define')).toBeUndefined()
  })

  it('is inert while the agents flag is off', async () => {
    const { run } = setup()
    for (const mode of ['', 'off', 'on']) expect((await run(mode)).code).toBe('flag_off')
  })

  it('lists builtins and open custom kinds only, without argv, env, program or secret', async () => {
    const r = await setup().run('auto')
    expect(r.ok).toBe(true)
    const kinds = r.data?.kinds as { id: string; builtin: boolean; headless: boolean }[]
    expect(r.data?.count).toBe(kinds.length)
    expect(kinds.map((k) => k.id)).toEqual(expect.arrayContaining(['claude', 'custom:open']))
    expect(kinds.some((k) => k.id === 'custom:closed')).toBe(false)
    expect(kinds.find((k) => k.id === 'custom:open')).toEqual({ id: 'custom:open', label: 'Open', builtin: false, headless: true })
    const json = JSON.stringify(r)
    for (const leak of [SECRET, '--secret-arg', process.execPath, 'UPSTREAM_TOKEN', 'API_TOKEN']) expect(json).not.toContain(leak)
  })

  it('rejects unexpected input keys', async () => {
    const r = await setup().run('auto', { projectId: 'p1', program: '/bin/sh' })
    expect(r.ok).toBe(false)
  })
})
