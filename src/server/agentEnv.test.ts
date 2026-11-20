import { afterEach, describe, expect, it } from 'vitest'
import { scrubAgentEnv } from './agentEnv'
import { setProxyEndpointSource } from './credentialProxy/credentialProxy.env'

const PROXY = { url: 'http://127.0.0.1:41999', token: 'wtp_placeholder-test-only' } // test-only
afterEach(() => setProxyEndpointSource(() => null))

describe('scrubAgentEnv', () => {
  it('keeps PATH/HOME/model vars, swaps a credential for the proxy placeholder, drops WEBTERM_*/NODETERM_* secrets and other providers', () => {
    setProxyEndpointSource(() => PROXY)
    const env = scrubAgentEnv({
      PATH: '/usr/bin', HOME: '/home/u', OPENAI_API_KEY: 'sk-test-value', ANTHROPIC_API_KEY: 'sk-ant-test', // test-only
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:4000', ANTHROPIC_MODEL: 'm', ANTHROPIC_CUSTOM_HEADERS: 'X-K: sk-hdr', OPENCODE_CONFIG: '/x', // test-only
      WEBTERM_TOKEN: 'root-secret', NODETERM_TOKEN: 'nd-secret', RANDOM_UNRELATED: 'drop-me', // test-only
    })
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/home/u', ANTHROPIC_API_KEY: PROXY.token, ANTHROPIC_BASE_URL: PROXY.url, ANTHROPIC_MODEL: 'm', CLAUDE_CODE_RETRY_WATCHDOG: '1' })
  })

  it('a credential without a running proxy fails closed instead of leaking the key', () => {
    expect(() => scrubAgentEnv({ PATH: '/bin', ANTHROPIC_AUTH_TOKEN: 'tok-test' })).toThrow('credential_proxy_unavailable') // test-only
  })

  it('without a credential nothing is added and no proxy is needed', () => {
    expect(scrubAgentEnv({ PATH: '/bin', ANTHROPIC_BASE_URL: 'http://gw.test' })).toEqual({ PATH: '/bin', ANTHROPIC_BASE_URL: 'http://gw.test', CLAUDE_CODE_RETRY_WATCHDOG: '1' })
  })
})
