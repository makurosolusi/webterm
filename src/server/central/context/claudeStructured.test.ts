// The shared helper runner against a fake `claude` (no model is reached): argv carries --model/--effort,
// the answer carries usage with the real model from modelUsage, and every output-only call books its kind.
import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFakeClaude } from '../runtime/claude.fakeBin'
import { createClaudeClassifier } from '../../policy/policy.classifier.claude'
import type { HelperKind, HelperUsage } from '../../cost/costCapture'
import { HELPER_EFFORT, createClaudeStructured, createStructuredRunner, parseStructuredAnswer } from './claudeStructured'

const dir = mkdtempSync(join(tmpdir(), 'structured-'))
const prevData = process.env.WEBTERM_DATA_DIR
process.env.WEBTERM_DATA_DIR = join(dir, 'data') // provider store lookups stay inside the test dir
afterAll(() => {
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
