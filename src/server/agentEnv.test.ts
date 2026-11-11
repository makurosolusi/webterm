import { describe, expect, it } from 'vitest'
import { scrubAgentEnv } from './agentEnv'

describe('scrubAgentEnv', () => {
  it('keeps PATH/HOME/Claude provider keys and drops WEBTERM_*/NODETERM_* secrets and other providers', () => {
    const env = scrubAgentEnv({
      PATH: '/usr/bin', HOME: '/home/u', OPENAI_API_KEY: 'sk-test-value', ANTHROPIC_API_KEY: 'sk-ant-test', // test-only
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:4000', OPENCODE_CONFIG: '/x', // test-only
      WEBTERM_TOKEN: 'root-secret', NODETERM_TOKEN: 'nd-secret', RANDOM_UNRELATED: 'drop-me', // test-only
    })
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/home/u', ANTHROPIC_API_KEY: 'sk-ant-test', ANTHROPIC_BASE_URL: 'http://127.0.0.1:4000', CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1' })
  })
})
