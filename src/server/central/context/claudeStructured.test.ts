// The shared helper runner against a fake `claude` (no model is reached): argv carries --model/--effort,
// the answer carries usage with the real model from modelUsage, and every output-only call books its kind.
import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFakeClaude } from '../runtime/claude.fakeBin'
import { resetProviderConfig, saveProvider } from '../../claudeProvider/claudeProvider.store'
import { setProxyEndpointSource } from '../../credentialProxy/credentialProxy.env'
import { createClaudeClassifier } from '../../policy/policy.classifier.claude'
import type { HelperKind, HelperUsage } from '../../cost/costCapture'
import { HELPER_EFFORT, createClaudeStructured, createStructuredRunner, parseStructuredAnswer, structuredArgv } from './claudeStructured'

const dir = mkdtempSync(join(tmpdir(), 'structured-'))
const prevData = process.env.WEBTERM_DATA_DIR
process.env.WEBTERM_DATA_DIR = join(dir, 'data') // provider store lookups stay inside the test dir
setProxyEndpointSource(() => ({ url: 'http://127.0.0.1:41999', token: 'wtp_placeholder-test-only' })) // test-only
afterAll(() => {
  setProxyEndpointSource(() => null)
  if (prevData === undefined) delete process.env.WEBTERM_DATA_DIR
  else process.env.WEBTERM_DATA_DIR = prevData
  rmSync(dir, { recursive: true, force: true })
})

// test-only fixture: the documented `--output-format json` result shape
const RESULT = (output: unknown) => ({
  type: 'result', subtype: 'success', structured_output: output, total_cost_usd: 0.0021,
  usage: { input_tokens: 1200, output_tokens: 80, cache_read_input_tokens: 300, cache_creation_input_tokens: 40 },
  modelUsage: { 'claude-haiku-5-5': { costUSD: 0.002 }, 'claude-sonnet-5-5': { costUSD: 0.0001 } },
})

/** A fake claude that records its argv and answers with `output`. */
function fake(name: string, output: unknown): { bin: string; argv: () => string[] } {
  const log = join(dir, `${name}.argv.json`)
  const bin = writeFakeClaude(dir, `fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)))
readStdin()
process.stdout.write(${JSON.stringify(JSON.stringify(RESULT(output)))})`)
  return { bin, argv: () => JSON.parse(readFileSync(log, 'utf8')) as string[] }
}

const after = (argv: string[], flag: string): string | undefined => argv[argv.indexOf(flag) + 1]
const signal = () => new AbortController().signal
const USAGE: HelperUsage = { input: 1200, output: 80, cacheRead: 300, cacheWrite: 40, costMicros: 2100, model: 'claude-haiku-5-5' }

describe('structured runner', () => {
  it('passes --model and --effort (default low) and returns output + usage with the real model', async () => {
    const f = fake('run', { ok: true })
    const answer = await createStructuredRunner('consolidator', { bin: f.bin })({ prompt: 'x', schema: {} }, signal())
    expect(answer).toEqual({ output: { ok: true }, usage: USAGE })
    expect([after(f.argv(), '--model'), after(f.argv(), '--effort')]).toEqual(['haiku', HELPER_EFFORT])
    expect(HELPER_EFFORT).toBe('low')

    const g = fake('run2', { ok: true })
    await createStructuredRunner('brief', { bin: g.bin, model: 'sonnet', effort: 'medium' })({ prompt: 'x', schema: {} }, signal())
    expect([after(g.argv(), '--model'), after(g.argv(), '--effort')]).toEqual(['sonnet', 'medium'])
  })

  it('never overrides a provider model: card model drops --model, a server-env tier var keeps the alias, SMALL_FAST is passed by name', async () => {
    const bare = { ...RESULT({ ok: true }), modelUsage: undefined }
    const fakeBare = (name: string) => {
      const log = join(dir, `${name}.argv.json`)
      const bin = writeFakeClaude(dir, `fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)))
readStdin()
process.stdout.write(${JSON.stringify(JSON.stringify(bare))})`)
      return { bin, argv: () => JSON.parse(readFileSync(log, 'utf8')) as string[] }
    }
    saveProvider({ mode: 'custom', baseUrl: 'http://127.0.0.1:9', credential: 'authToken', model: 'my-proxy/glm-4.6' }, 'test-only-secret')
    try {
      const card = fakeBare('card')
      const a = await createStructuredRunner('brief', { bin: card.bin })({ prompt: 'x', schema: {} }, signal())
      expect(card.argv()).not.toContain('--model')
      expect(a.usage.model).toBe('my-proxy/glm-4.6')
      resetProviderConfig()

      process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'proxy-small'
      const tier = fakeBare('tier')
      const b = await createStructuredRunner('brief', { bin: tier.bin })({ prompt: 'x', schema: {} }, signal())
      expect(after(tier.argv(), '--model')).toBe('haiku')
      expect(b.usage.model).toBe('proxy-small')
      delete process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL

      process.env.ANTHROPIC_SMALL_FAST_MODEL = 'proxy-fast'
      const fast = fakeBare('fast')
      await createStructuredRunner('brief', { bin: fast.bin })({ prompt: 'x', schema: {} }, signal())
      expect(after(fast.argv(), '--model')).toBe('proxy-fast')
    } finally {
      delete process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL
      delete process.env.ANTHROPIC_SMALL_FAST_MODEL
      resetProviderConfig()
    }
  })

  it('books every output-only call under its kind; a failing book never fails the helper', async () => {
    const booked: Array<[HelperKind, HelperUsage]> = []
    const f = fake('book', { narrative: 'n' })
    const call = createClaudeStructured('handoff', { bin: f.bin, book: (k, u) => { booked.push([k, u]) } })
    expect(await call({ prompt: 'x', schema: {} }, signal())).toEqual({ narrative: 'n' })
    expect(booked).toEqual([['handoff', USAGE]])
    const broken = createClaudeStructured('brief', { bin: f.bin, book: () => { throw new Error('db gone') } })
    expect(await broken({ prompt: 'x', schema: {} }, signal())).toEqual({ narrative: 'n' })
  })

  it('the policy classifier runs on the same runner and books as classifier', async () => {
    const booked: HelperKind[] = []
    const f = fake('cls', { decision: 'allow', reason: 'tests only' })
    const classify = createClaudeClassifier({ bin: f.bin, book: (k) => { booked.push(k) } })
    expect(await classify({ tool: 'Bash', input: {} } as never, signal())).toEqual({ decision: 'allow', reason: 'tests only' })
    expect(booked).toEqual(['classifier'])
    expect(after(f.argv(), '--effort')).toBe('low')
    expect(JSON.parse(after(f.argv(), '--json-schema')!)).toMatchObject({ required: ['decision', 'reason'] })
  })

  it('falls back to the requested model without modelUsage and throws on a failed result', () => {
    const bare = JSON.stringify({ subtype: 'success', structured_output: {}, usage: {} })
    expect(parseStructuredAnswer(bare, 'opus').usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costMicros: null, model: 'opus' })
    expect(() => parseStructuredAnswer(JSON.stringify({ subtype: 'error_max_turns' }))).toThrow(/no structured output/)
  })
})

describe('API time and isolation flags', () => {
  it('parseStructuredAnswer carries the CLI duration_api_ms as apiMs, and omits it when absent or not a number', () => {
    const base = { subtype: 'success', structured_output: { ok: true } }
    expect(parseStructuredAnswer(JSON.stringify({ ...base, duration_api_ms: 2842 })).apiMs).toBe(2842)
    expect(parseStructuredAnswer(JSON.stringify(base))).not.toHaveProperty('apiMs')
    expect(parseStructuredAnswer(JSON.stringify({ ...base, duration_api_ms: 'fast' }))).not.toHaveProperty('apiMs')
  })
  it('createClaudeStructured hands the API time to onApiMs without changing the returned output', async () => {
    const bin = writeFakeClaude(dir, `readStdin()
process.stdout.write(${JSON.stringify(JSON.stringify({ ...RESULT({ ok: true }), duration_api_ms: 1234 }))})`)
    let seen: number | undefined
    const out = await createClaudeStructured('page_reader', { bin, book: () => undefined })({ prompt: 'x', schema: {}, onApiMs: (ms) => { seen = ms } }, signal())
    expect(out).toEqual({ ok: true })
    expect(seen).toBe(1234)
  })
  it('the child env carries the traffic switch and still no WEBTERM_/OPENAI_/OAuth secret from the server env', async () => {
    const out = join(dir, 'env.json')
    const bin = writeFakeClaude(dir, `readStdin()
fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.env))
process.stdout.write(${JSON.stringify(JSON.stringify(RESULT({ ok: true })))})`)
    const prev = { ...process.env }
    Object.assign(process.env, { WEBTERM_TOKEN: 'root-test-only', OPENAI_API_KEY: 'sk-test-only', CLAUDE_CODE_OAUTH_TOKEN: 'oauth-test-only' }) // test-only
    try { await createStructuredRunner('page_reader', { bin })({ prompt: 'x', schema: {} }, signal()) } finally {
      for (const k of ['WEBTERM_TOKEN', 'OPENAI_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k] }
    }
    const env = JSON.parse(readFileSync(out, 'utf8')) as Record<string, string>
    expect(env['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC']).toBe('1')
    expect(Object.keys(env).filter((k) => /^(WEBTERM_|NODETERM_|OPENAI_|CLAUDE_CODE_OAUTH)/.test(k))).toEqual([])
  })
  it('the helper argv always keeps every isolation flag (no tools, no MCP, no settings, no slash commands, no session)', () => {
    const argv = structuredArgv({ type: 'object' })
    const flag = (f: string): string | undefined => argv[argv.indexOf(f) + 1]
    expect(flag('--tools')).toBe('')
    expect(flag('--setting-sources')).toBe('')
    for (const f of ['--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence', '--json-schema', '--max-budget-usd']) expect(argv).toContain(f)
  })
})
