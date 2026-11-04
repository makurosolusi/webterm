// The 1h prompt-cache TTL (TurnInput.cacheEnv) reaches the Central `claude` child next to the provider
// env, and cannot override it. Real child process against a fake `claude`; it reports lengths, never the key.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveProvider } from '../../claudeProvider/claudeProvider.store'
import { ClaudeRuntime } from './claudeRuntime'
import { createCentralMcpLink } from './claudeMcp'
import { recorder, turnInput, writeFakeClaude } from './claude.fakeBin'

const KEY = 'sk-test-only-0123456789abcdef' // test-only
let dir = ''
let prev: string | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'claude-cache-env-'))
  prev = process.env.WEBTERM_DATA_DIR
  process.env.WEBTERM_DATA_DIR = join(dir, 'data')
  saveProvider({ mode: 'apiKey' }, KEY)
})
afterEach(() => {
  if (prev === undefined) delete process.env.WEBTERM_DATA_DIR
  else process.env.WEBTERM_DATA_DIR = prev
  rmSync(dir, { recursive: true, force: true })
})

async function run(cacheEnv?: Record<string, string>) {
  const out = join(dir, 'seen.json')
  const bin = writeFakeClaude(dir, `fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({
    ttl: process.env.ENABLE_PROMPT_CACHING_1H ?? null,
    keyLen: (process.env.ANTHROPIC_API_KEY || '').length,
    scrub: process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB ?? null,
  }))
try { readStdin() } catch {}
process.exit(1)`)
  await new ClaudeRuntime({
    executable: bin, workDir: join(dir, 'work'), killGraceMs: 50, newSessionId: () => 'sid',
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir },
    mcp: createCentralMcpLink({ dir: join(dir, 'mcp'), port: 1, mint: () => ({ token: 'wcap_test-only', revoke: () => undefined }) }), // test-only
  }).turn(turnInput(cacheEnv ? { cacheEnv } : {}), recorder().emit)
  return JSON.parse(readFileSync(out, 'utf8')) as { ttl: string | null; keyLen: number; scrub: string | null }
}

describe('Central runtime applies TurnInput.cacheEnv', () => {
  it('sets ENABLE_PROMPT_CACHING_1H alongside the provider env', async () => {
    expect(await run({ ENABLE_PROMPT_CACHING_1H: '1' })).toEqual({ ttl: '1', keyLen: KEY.length, scrub: '1' })
  })

  it('no cacheEnv = CLI default TTL, provider env unchanged', async () => {
    expect(await run()).toEqual({ ttl: null, keyLen: KEY.length, scrub: '1' })
  })

  it('a cacheEnv key cannot clobber the provider credential', async () => {
    expect(await run({ ENABLE_PROMPT_CACHING_1H: '1', ANTHROPIC_API_KEY: 'x' })).toEqual({ ttl: '1', keyLen: KEY.length, scrub: '1' })
  })
})
