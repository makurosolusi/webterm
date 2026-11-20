import { describe, expect, it } from 'vitest'
import { scrubExecEnv, type ExecHandle, type ExecSpec } from '../central/agents/execRunner'
import type { ProviderEnv } from '../claudeProvider/claudeProvider.model'
import { createAgentSpawner } from './agentSpawn'

// test-only: a fake provider value and a fake exec that captures the spec; nothing is spawned.
const KEY = 'wtp_placeholder-test-only' // the credential-proxy placeholder: the only key a child ever holds
const KEY_MODE: ProviderEnv = {
  set: { ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: 'http://127.0.0.1:41999' },
  unset: ['ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_SUBPROCESS_ENV_SCRUB'],
}

function rig(pe: ProviderEnv) {
  const specs: ExecSpec[] = []
  const exec = (spec: ExecSpec): ExecHandle => {
    specs.push(spec)
    return { pid: 1, done: new Promise(() => {}), tail: () => '', kill: () => {} }
  }
  const spawner = createAgentSpawner({
    exec, providerEnv: () => pe, ancestors: () => [], registerSpawn: () => {}, record: () => {}, onPtyExit: () => {},
  })
  return { specs, spawner }
}

const parentEnv = { PATH: '/usr/bin', HOME: '/h', ANTHROPIC_AUTH_TOKEN: 'stale', ANTHROPIC_BASE_URL: 'https://old.example', CLAUDE_CODE_USE_BEDROCK: '1' }

describe('headless Claude spawns use the Claude provider setting', () => {
  it('key mode: the child env gets the provider vars and loses the stale ones (DAG/routine shape)', async () => {
    const r = rig(KEY_MODE)
    const res = await r.spawner.spawn({ door: 'routine', mode: 'headless', parent: 'routine:r1', cwd: '/tmp/wt', prompt: 'go', headless: { env: parentEnv } })
    expect(res.ok).toBe(true)
    const child = scrubExecEnv(r.specs[0]?.env, r.specs[0]?.overrides)
    expect(child.ANTHROPIC_API_KEY === KEY).toBe(true)
    expect(child.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBeUndefined()
    expect(child.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(child.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:41999')
    expect(child.CLAUDE_CODE_USE_BEDROCK).toBeUndefined()
    expect(child.PATH).toBe('/usr/bin')
  })

  it('a door override cannot clobber the provider credential; other door overrides survive', async () => {
    const r = rig(KEY_MODE)
    await r.spawner.spawn({ door: 'orchestrator', mode: 'headless', parent: 'central', cwd: '/tmp/wt', prompt: 'go', headless: { overrides: { ANTHROPIC_API_KEY: 'other', EXTRA: 'x' } } })
    expect(r.specs[0]?.overrides?.ANTHROPIC_API_KEY === KEY).toBe(true)
    expect(r.specs[0]?.overrides?.EXTRA).toBe('x')
  })

  it('login mode leaves the door env untouched', async () => {
    const r = rig({ set: {}, unset: [] })
    await r.spawner.spawn({ door: 'routine', mode: 'headless', parent: 'routine:r1', cwd: '/tmp/wt', prompt: 'go', headless: { env: parentEnv } })
    expect(r.specs[0]?.env).toBe(parentEnv)
    expect(r.specs[0]?.overrides).toEqual({})
  })

  it('a non-Claude kind never receives the Claude credential', async () => {
    const r = rig(KEY_MODE)
    await r.spawner.spawn({ door: 'central', mode: 'headless', kind: 'opencode', parent: 'central', cwd: '/tmp/wt', headless: { argv: ['opencode', 'run', 'x'], env: parentEnv } })
    expect(r.specs[0]?.overrides?.ANTHROPIC_API_KEY).toBeUndefined()
    expect(r.specs[0]?.env).toBe(parentEnv)
  })
})
