import { describe, expect, it } from 'vitest'
import type { ExecHandle, ExecSpec } from '../central/agents/execRunner'
import { createAgentSpawner, modelFlags } from '../spawn/agentSpawn'
import { resolveModel } from './modelLadder'
import { modelRequest, requestedModel } from './modelRequest'

// test-only model names
const CARD = { ANTHROPIC_MODEL: 'my-proxy/glm-4.6' }

describe('modelRequest', () => {
  it('no provider model: the alias as today', () => {
    expect(modelRequest('haiku', {})).toEqual({ flag: 'haiku', requested: 'haiku' })
  })

  it('a tier var keeps the alias (Claude Code resolves it) and names what is requested', () => {
    expect(modelRequest('sonnet', { ...CARD, ANTHROPIC_DEFAULT_SONNET_MODEL: 'proxy-mid' })).toEqual({ flag: 'sonnet', requested: 'proxy-mid' })
    expect(modelRequest('haiku', { ANTHROPIC_SMALL_FAST_MODEL: 'proxy-fast' })).toEqual({ flag: 'proxy-fast', requested: 'proxy-fast' })
  })

  it('only the card/main model: no --model, so the alias cannot bypass it', () => {
    expect(modelRequest('opus', CARD)).toEqual({ flag: null, requested: 'my-proxy/glm-4.6' })
    expect(modelRequest('claude-sonnet-4-6', CARD)).toEqual({ flag: null, requested: 'my-proxy/glm-4.6' })
    expect(modelRequest('sonnet', { ANTHROPIC_DEFAULT_HAIKU_MODEL: 'proxy-small' })).toEqual({ flag: 'sonnet', requested: 'sonnet' })
  })

  it('cost rows record what was requested', () => {
    expect(requestedModel('sonnet', () => CARD)).toBe('my-proxy/glm-4.6')
    expect(requestedModel('sonnet', () => ({}))).toBe('sonnet')
    expect(requestedModel(null, () => CARD)).toBeNull()
  })
})

describe('the ladder respects the provider model', () => {
  const pick = resolveModel({ kind: 'agent-spawn' })

  it('modelFlags keeps the tier effort but drops a conflicting --model', () => {
    expect(modelFlags([], pick, () => ({}))).toEqual(['--model', 'sonnet', '--effort', 'medium'])
    expect(modelFlags([], pick, () => CARD)).toEqual(['--effort', 'medium'])
    expect(modelFlags([], pick, () => ({ ANTHROPIC_DEFAULT_SONNET_MODEL: 'proxy-mid' }))).toEqual(['--model', 'sonnet', '--effort', 'medium'])
  })

  it('a headless worker under a card model gets no --model', async () => {
    const specs: ExecSpec[] = []
    const exec = (spec: ExecSpec): ExecHandle => { specs.push(spec); return { pid: 1, done: new Promise(() => {}), tail: () => '', kill: () => {} } }
    const spawner = createAgentSpawner({
      exec, ancestors: () => [], registerSpawn: () => {}, record: () => {}, onPtyExit: () => {},
      providerEnv: () => ({ set: { ANTHROPIC_API_KEY: 'test-only', ...CARD }, unset: [] }),
    })
    await spawner.spawn({ door: 'routine', mode: 'headless', parent: 'routine:r1', cwd: '/tmp/wt', prompt: 'go', headless: { pick, env: { PATH: '/usr/bin' } } })
    expect(specs[0]?.argv).not.toContain('--model')
    expect(specs[0]?.argv.slice(-2)).toEqual(['--effort', 'medium'])
  })
})
