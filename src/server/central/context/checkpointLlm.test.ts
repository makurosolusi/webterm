// LLM checkpoint summarizer (F5-c): model output used when it matches the schema, deterministic fallback on
// a malformed answer, a failure or a timeout, and the near-rotation gate. The model is always a fake.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openFixture, seedPortfolio, type Fixture } from '../centralTestFixture.testutil'
import { appendMessage, getOrCreateConversation } from '../conversationStore'
import { createCentralSummarize, createLlmSummarize, parseCheckpointSummary, LLM_SUMMARY_RATIO } from './checkpointLlm'
import { createCheckpoint, createFallbackCheckpoint } from './checkpointSummarizer'
import { createContextAssembler } from './contextAssembler'
import { recordCtxTokens } from './contextUsage'
import type { StructuredCall } from './claudeStructured'

const CONV = 'central:project:p1'
const ENV = { WEBTERM_CENTRAL_CONTEXT_WINDOW: '1000', WEBTERM_CENTRAL_CHECKPOINT: 'on' }
let fixture: Fixture
beforeEach(() => {
  fixture = openFixture()
  seedPortfolio(fixture.db)
  getOrCreateConversation(fixture.db, 'project:p1', 1)
})
afterEach(() => fixture.close())

const say = (text: string, i = 1) => appendMessage(fixture.db, {
  conversationId: CONV, role: 'human', parts: [{ type: 'text', text }], now: i + 2,
}).message.id
const turnAt = (tokens: number, id = 't1') => {
  fixture.db.query(`INSERT INTO central_turn (id, conversation_id, message_id, status, started_at) VALUES (?, ?, 'm', 'succeeded', 1)`).run(id, CONV)
  recordCtxTokens(fixture.db, id, tokens)
}
const VALID = { goals: ['ship F5-c'], decisions: ['use haiku'], openQuestions: [], nextSteps: ['write tests'], filesTouched: ['src/a.ts'] }
const answer = (value: unknown): StructuredCall => async () => value

describe('parseCheckpointSummary', () => {
  it('accepts the strict schema and rejects missing, extra-long or non-string fields', () => {
    expect(parseCheckpointSummary(VALID)).toEqual(VALID)
    expect(parseCheckpointSummary({ ...VALID, goals: undefined })).toBeNull()
    expect(parseCheckpointSummary({ ...VALID, goals: [42] })).toBeNull()
    expect(parseCheckpointSummary({ ...VALID, goals: ['x'.repeat(201)] })).toBeNull()
    expect(parseCheckpointSummary({ goals: [], decisions: [], openQuestions: [], nextSteps: [], filesTouched: [] })).toBeNull()
  })
})

describe('createLlmSummarize via createCheckpoint', () => {
  it('stores the model summary when the answer is valid', async () => {
    say('hello')
    const cp = await createCheckpoint({ db: fixture.db, conversationId: CONV, summarize: createLlmSummarize(answer(VALID)), now: () => 9 })
    expect(cp?.source).toBe('auto')
    expect(cp?.narrative).toBe('Goals: ship F5-c\nDecisions: use haiku\nNext steps: write tests\nFiles touched: src/a.ts')
  })

  it('falls back when the answer is off-schema', async () => {
    say('hello')
    const cp = await createCheckpoint({ db: fixture.db, conversationId: CONV, summarize: createLlmSummarize(answer({ narrative: 'free text' })), now: () => 9 })
    expect(cp?.source).toBe('fallback')
    expect(cp?.narrative).toBe('human: hello')
  })

  it('falls back on a model failure and keeps the previous summary in the seed', async () => {
    say('one')
    await createCheckpoint({ db: fixture.db, conversationId: CONV, summarize: createLlmSummarize(answer(VALID)), now: () => 9 })
    say('two', 2)
    const boom: StructuredCall = async () => { throw new Error('claude exited 1') }
    const cp = await createCheckpoint({ db: fixture.db, conversationId: CONV, summarize: createLlmSummarize(boom), now: () => 10 })
    expect(cp?.source).toBe('fallback')
    expect(cp?.narrative.startsWith('Goals: ship F5-c')).toBe(true)
    expect(cp?.narrative.endsWith('human: two')).toBe(true)
  })

  it('falls back on timeout and aborts the model call', async () => {
    say('one')
    let aborted = false
    const hang: StructuredCall = (_req, signal) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')) })
    })
    const cp = await createCheckpoint({ db: fixture.db, conversationId: CONV, summarize: createLlmSummarize(hang), now: () => 9, timeoutMs: 20 })
    expect(cp?.source).toBe('fallback')
    expect(aborted).toBe(true)
  })
})

describe('createCentralSummarize', () => {
  it('asks the model only near rotation and uses the rolling summary below it', async () => {
    let calls = 0
    const call: StructuredCall = async () => { calls += 1; return VALID }
    const summarize = createCentralSummarize({ call })
    say('one')
    turnAt(Math.floor(LLM_SUMMARY_RATIO * 1000) - 50)
    const low = await createCheckpoint({ db: fixture.db, conversationId: CONV, summarize, now: () => 9, env: ENV })
    expect(calls).toBe(0)
    expect(low?.narrative).toBe('human: one')
    say('two', 2)
    turnAt(Math.ceil(LLM_SUMMARY_RATIO * 1000) + 10, 't2')
    const high = await createCheckpoint({ db: fixture.db, conversationId: CONV, summarize, now: () => 10, env: ENV })
    expect(calls).toBe(1)
    expect(high?.narrative.startsWith('Goals: ship F5-c')).toBe(true)
  })

  it('the 70% rotation seeds the fresh session from the model summary', async () => {
    say('one')
    turnAt(650)
    await createCheckpoint({ db: fixture.db, conversationId: CONV, summarize: createCentralSummarize({ call: answer(VALID) }), now: () => 9, env: ENV })
    turnAt(720, 't2') // next turn crosses 70%
    const built = createContextAssembler({ env: ENV, memory: { block: () => ({ text: '', items: [], truncated: false }) } })
      .build({ db: fixture.db, conversationId: CONV, text: 'continue', now: () => 11, memoryEnabled: false } as never)
    expect((built as { rotateSession?: boolean }).rotateSession).toBe(true)
    expect(built.prompt).toContain('Goals: ship F5-c')
  })

  it('a rotation without a fresh model summary still seeds a tested fallback', () => {
    say('one')
    const cp = createFallbackCheckpoint(fixture.db, CONV, 5)
    expect(cp).toMatchObject({ source: 'fallback', narrative: 'human: one' })
  })
})
