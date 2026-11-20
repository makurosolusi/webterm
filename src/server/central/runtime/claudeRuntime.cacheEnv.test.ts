// The 1h prompt-cache TTL (TurnInput.cacheEnv) reaches the Central `claude` child next to the provider
// env, and cannot override it. Reads the SDK `env` option (the child's whole environment); lengths only, never the key.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveProvider } from '../../claudeProvider/claudeProvider.store'
import { setProxyEndpointSource } from '../../credentialProxy/credentialProxy.env'
import { ClaudeRuntime } from './claudeRuntime'
import { createCentralMcpLink } from './claudeMcp'
import { recorder, turnInput } from './claude.fakeBin'
import { fakeQuery } from './claude.fakeQuery'

const KEY = 'sk-test-only-0123456789abcdef' // test-only
const PROXY = { url: 'http://127.0.0.1:41999', token: 'wtp_placeholder-test-only' } // test-only
let dir = ''
let prev: string | undefined

beforeEach(() => {
  setProxyEndpointSource(() => PROXY)
  dir = mkdtempSync(join(tmpdir(), 'claude-cache-env-'))
  prev = process.env.WEBTERM_DATA_DIR
  process.env.WEBTERM_DATA_DIR = join(dir, 'data')
  saveProvider({ mode: 'apiKey' }, KEY)
})
afterEach(() => {
  setProxyEndpointSource(() => null)
  if (prev === undefined) delete process.env.WEBTERM_DATA_DIR
  else process.env.WEBTERM_DATA_DIR = prev
  rmSync(dir, { recursive: true, force: true })
})

async function run(cacheEnv?: Record<string, string>) {
  const fake = fakeQuery([])
  await new ClaudeRuntime({
    query: fake.query, workDir: join(dir, 'work'), newSessionId: () => 'sid',
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir },
    mcp: createCentralMcpLink({ dir: join(dir, 'mcp'), port: 1, mint: () => ({ token: 'wcap_test-only', revoke: () => undefined }) }), // test-only
  }).turn(turnInput(cacheEnv ? { cacheEnv } : {}), recorder().emit)
  const env = fake.calls[0]?.options.env ?? {}
  return { ttl: env.ENABLE_PROMPT_CACHING_1H ?? null, key: env.ANTHROPIC_API_KEY ?? null, scrub: env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB ?? null }
}

describe('Central runtime applies TurnInput.cacheEnv', () => {
  it('sets ENABLE_PROMPT_CACHING_1H alongside the provider env', async () => {
    expect(await run({ ENABLE_PROMPT_CACHING_1H: '1' })).toEqual({ ttl: '1', key: PROXY.token, scrub: null })
  })

  it('no cacheEnv = CLI default TTL, provider env unchanged', async () => {
    expect(await run()).toEqual({ ttl: null, key: PROXY.token, scrub: null })
  })

  it('a cacheEnv key cannot clobber the provider credential', async () => {
    expect(await run({ ENABLE_PROMPT_CACHING_1H: '1', ANTHROPIC_API_KEY: 'x' })).toEqual({ ttl: '1', key: PROXY.token, scrub: null })
  })
})
