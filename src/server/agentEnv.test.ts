import { describe, expect, it } from 'vitest'
import { scrubAgentEnv } from './agentEnv'

describe('scrubAgentEnv', () => {
  it('keeps PATH/HOME/provider keys and drops WEBTERM_*/NODETERM_* secrets', () => {
    const env = scrubAgentEnv({
      PATH: '/usr/bin', HOME: '/home/u', OPENAI_API_KEY: 'sk-test-value', ANTHROPIC_API_KEY: 'sk-ant-test', // test-only
      WEBTERM_TOKEN: 'root-secret', NODETERM_TOKEN: 'nd-secret', RANDOM_UNRELATED: 'drop-me', // test-only
    })
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/home/u', OPENAI_API_KEY: 'sk-test-value', ANTHROPIC_API_KEY: 'sk-ant-test' })
  })
})
