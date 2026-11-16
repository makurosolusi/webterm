import { describe, expect, test } from 'bun:test'
import { FakePty } from '../fakePty.testutil'
import { claudeHeadersPath } from '../hooksPaths'
import { NODE_HEADERS_ENV } from '../hooksTokens'
import { ptyEnv } from '../ptyShell'
import { Sessions } from '../sessions'
import { AGENT_CHAT_DROPPED_ENV, agentChatEnv } from './agentChat.env'

const NO_PROVIDER = { set: {}, unset: [] }
// test-only values; assertions compare them, nothing prints them.
const AUTH = { ANTHROPIC_API_KEY: 'sk-test-only-key', ANTHROPIC_BASE_URL: 'https://gw.example.test', ANTHROPIC_AUTH_TOKEN: 'test-only-token', ANTHROPIC_MODEL: 'claude-test', CLAUDE_CODE_USE_BEDROCK: '1' }
const parentEnv = {
  PATH: '/usr/bin:/bin', HOME: '/home/test', CLAUDE_CONFIG_DIR: '/tmp/cfg-test', ...AUTH,
  CLAUDECODE: '1', TMUX: '/tmp/tmux-1/default,1,0', WEBTERM_TOKEN: 'root-test-only', WEBTERM_NODE_ID: 'parent-node', CAP: 'wcap_test-only',
}

describe('agentChatEnv', () => {
  test('exported auth and model vars reach the child unchanged', () => {
    const env = agentChatEnv({ nodeId: 'n', port: 1, parentEnv, provider: NO_PROVIDER })
    for (const [k, v] of Object.entries(AUTH)) expect(env[k] === v).toBe(true)
    expect(env.CLAUDE_CONFIG_DIR).toBe('/tmp/cfg-test')
  })

  test('never passes CLAUDECODE, TMUX, root tokens or capability tokens', () => {
    const env = agentChatEnv({ nodeId: 'n', port: 1, parentEnv, provider: NO_PROVIDER, profileEnv: { CLAUDECODE: '1' } })
    for (const k of ['CLAUDECODE', 'TMUX', 'WEBTERM_TOKEN', 'CAP']) expect(k in env).toBe(false)
    expect(env.WEBTERM_NODE_ID).toBe('n')
  })

  test('the active provider is applied like the terminal launch file (set + unset)', () => {
    const provider = { set: { ANTHROPIC_BASE_URL: 'https://proxy.example.test', ANTHROPIC_AUTH_TOKEN: 'provider-test-only' }, unset: ['ANTHROPIC_API_KEY'] }
    const env = agentChatEnv({ nodeId: 'n', port: 1, parentEnv, provider })
    expect(env.ANTHROPIC_BASE_URL).toBe('https://proxy.example.test')
    expect(env.ANTHROPIC_AUTH_TOKEN === 'provider-test-only').toBe(true)
    expect('ANTHROPIC_API_KEY' in env).toBe(false)
  })

  test('carries the same node identity a terminal agent gets', () => {
    const env = agentChatEnv({ nodeId: 'node-7', port: 8701, parentEnv, provider: NO_PROVIDER })
    expect(env.WEBTERM_PORT).toBe('8701')
    expect(env[NODE_HEADERS_ENV]).toBe(claudeHeadersPath('node-7'))
    expect(env.PATH?.endsWith('/usr/bin:/bin')).toBe(true)
  })

  test('parity: same key set as a terminal claude agent for the same parent env, minus the documented drops', () => {
    const saved = Object.fromEntries(Object.keys(parentEnv).map((k) => [k, process.env[k]]))
    Object.assign(process.env, parentEnv)
    try {
      const spawns: { env?: Record<string, string> }[] = []
      const s = new Sessions({ spawn: (o) => { spawns.push(o); return new FakePty(1) } }, null)
      s.open({ t: 'open', id: 'parity-1', cols: 80, rows: 24, agentId: 'claude', cmd: 'claude', sessionId: '33333333-3333-4333-8333-333333333333' }, () => {})
      s.close('parity-1')
      // What spawnPty hands the agent command: filtered process env + the session overlay.
      const terminal = { ...ptyEnv(process.env, { interactive: false }), ...spawns[0]?.env }
      const chat = agentChatEnv({ nodeId: 'parity-1', port: Number(terminal.WEBTERM_PORT), provider: NO_PROVIDER })
      const dropped = new Set<string>([...AGENT_CHAT_DROPPED_ENV, ...Object.keys(terminal).filter((k) => terminal[k]?.startsWith('wcap_'))])
      expect(Object.keys(chat).sort()).toEqual(Object.keys(terminal).filter((k) => !dropped.has(k)).sort())
      for (const k of [NODE_HEADERS_ENV, 'WEBTERM_NODE_ID', 'WEBTERM_PORT', 'PATH', ...Object.keys(AUTH)]) expect(chat[k] === terminal[k]).toBe(true)
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })
})
