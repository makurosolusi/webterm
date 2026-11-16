import { afterEach, describe, expect, it } from 'vitest'
import { AGENT_CONFIG, AGENTS, BUILTIN_AGENT_IDS, agentConfig, isBuiltinAgent } from './workspace.agents'
import {
  CLAUDE_HOOK_SETTINGS_CAPABLE,
  CONTEXT_LINK_CAPABLE,
  MODEL_SWITCH_CAPABLE,
  PERMISSION_MODE_CAPABLE,
  RESUMABLE_AGENTS,
  SESSION_ID_CAPABLE,
  USAGE_CAPABLE,
  baseAgentOf,
  canContextLink,
  canResume,
  canSwitchModel,
  capabilityAgentId,
  hasClaudeHookSettings,
  hasPermissionMode,
  hasUsage,
  isPermissionMode,
  mintsSessionId,
  setCustomAgentBaseResolver,
} from './workspace.capabilities'

const predicates = [canResume, mintsSessionId, canContextLink, hasUsage, hasPermissionMode, canSwitchModel, hasClaudeHookSettings]
const lists = [RESUMABLE_AGENTS, SESSION_ID_CAPABLE, CONTEXT_LINK_CAPABLE, USAGE_CAPABLE, PERMISSION_MODE_CAPABLE, MODEL_SWITCH_CAPABLE, CLAUDE_HOOK_SETTINGS_CAPABLE]

afterEach(() => setCustomAgentBaseResolver(null))

describe('builtin agent table', () => {
  it('gives every builtin a complete, valid config', () => {
    for (const id of BUILTIN_AGENT_IDS) {
      const c = AGENT_CONFIG[id]
      expect(c.label.length).toBeGreaterThan(0)
      expect(c.color).toMatch(/^#[0-9a-f]{6}$/i)
      expect(c.launchCmd).toMatch(/^[a-z][\w-]*$/)
      expect(c.expectedProcess.length).toBeGreaterThan(0)
    }
    expect(AGENTS).toBe(AGENT_CONFIG)
  })
  it('lists only ids that have a config, and every ability list holds only builtins', () => {
    for (const id of BUILTIN_AGENT_IDS) expect(agentConfig(id)).toBe(AGENT_CONFIG[id])
    for (const list of lists) for (const id of list) expect(isBuiltinAgent(id)).toBe(true)
  })
  it('treats custom, legacy and prototype-key ids as non-builtin', () => {
    for (const id of ['custom:abc', 'custom', 'codex', '', 'constructor', 'toString', '__proto__']) {
      expect(agentConfig(id)).toBeUndefined()
      expect(isBuiltinAgent(id)).toBe(false)
    }
  })
})

describe('capability predicates', () => {
  it('are true for claude and false for agents without a base', () => {
    for (const p of predicates) {
      expect(p('claude')).toBe(true)
      expect(p('custom:x')).toBe(false)
      expect(p('codex')).toBe(false)
    }
  })
  it('follow a custom agent to its base harness', () => {
    setCustomAgentBaseResolver((id) => (id === 'custom:proxy' ? 'claude' : undefined))
    expect(baseAgentOf('custom:proxy')).toBe('claude')
    expect(capabilityAgentId('custom:proxy')).toBe('claude')
    for (const p of predicates) {
      expect(p('custom:proxy')).toBe(true)
      expect(p('custom:other')).toBe(false)
    }
  })
  it('never lets a custom entry override a builtin id', () => {
    setCustomAgentBaseResolver(() => 'claude')
    expect(baseAgentOf('claude')).toBeUndefined()
    expect(capabilityAgentId('claude')).toBe('claude')
  })
  it('stops inheriting once the resolver is cleared', () => {
    setCustomAgentBaseResolver(() => 'claude')
    setCustomAgentBaseResolver(null)
    expect(baseAgentOf('custom:proxy')).toBeUndefined()
    expect(canResume('custom:proxy')).toBe(false)
  })
})

describe('isPermissionMode', () => {
  it.each(['manual', 'auto', 'acceptEdits', 'plan', 'bypassPermissions'])('accepts %s', (m) => {
    expect(isPermissionMode(m)).toBe(true)
  })
  it.each([['default'], ['Plan'], [''], [' plan'], ['constructor'], [null], [undefined], [1], [{}]])('rejects %j', (m) => {
    expect(isPermissionMode(m)).toBe(false)
  })
})
