import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openFixture, seedPortfolio, type Fixture } from '../centralTestFixture.testutil'
import { appendMessage, getOrCreateConversation } from '../conversationStore'
import { CENTRAL_STEWARD_PROMPT } from '../runtime/claudeOptions'
import { CENTRAL_ADVISOR_PROMPT } from './advisorPrompt'
import { insertCheckpoint } from './checkpointStore'
import { CHECKPOINT_FLAG, createContextAssembler, type AssembledContext } from './contextAssembler'
import { ACTIVE_HUMAN_TURNS, ACTIVE_WINDOW_MS, centralCacheEnv, centralPrefixText } from './promptPrefix'

const ON = { [CHECKPOINT_FLAG]: 'on' }
const CONV = 'central:project:p1'
let fixture: Fixture
let jobs: Array<() => void>
beforeEach(() => {
  fixture = openFixture()
  seedPortfolio(fixture.db)
  getOrCreateConversation(fixture.db, 'project:p1', 1)
  jobs = []
})
afterEach(() => fixture.close())

const assembler = () => createContextAssembler({
  env: ON, memory: { block: (r) => ({ text: `mem for ${r.query}`, items: [], truncated: false }) }, scheduleIdle: (job) => jobs.push(job),
})
const build = (a: ReturnType<typeof assembler>, text: string, now: number) =>
  a.build({ db: fixture.db, conversationId: CONV, text, memoryEnabled: true, now: () => now }) as AssembledContext
const say = (i: number, at: number): string => appendMessage(fixture.db, {
  conversationId: CONV, role: 'human', parts: [{ type: 'text', text: `message ${i}` }], now: at,
}).message.id
const prefixRows = () => fixture.db.query('SELECT hash, hits, project_id FROM prefix ORDER BY created_at').all() as { hash: string; hits: number; project_id: string | null }[]

describe('stable prefix', () => {
  it('keeps the same hash across turns with different text, memory and clock', () => {
    const a = assembler()
    const one = build(a, 'first question', 1)
    const two = build(a, 'a different question', 999_999)
    expect(two.prefixHash).toBe(one.prefixHash)
    expect(prefixRows()).toEqual([{ hash: one.prefixHash, hits: 1, project_id: 'p1' }])
  })

  it('changes only when the stable input (checkpoint) changes', () => {
    const a = assembler()
    const before = build(a, 'q', 1).prefixHash
    const id = say(1, 2)
    insertCheckpoint(fixture.db, { conversationId: CONV, fromMessageId: id, toMessageId: id, factsJson: '{}', narrative: 'Intent: ship', source: 'auto', now: 5 })
    const after = build(a, 'q', 6).prefixHash
    expect(after).not.toBe(before)
    expect(build(a, 'other', 7).prefixHash).toBe(after)
    expect(prefixRows().map((r) => r.hits)).toEqual([0, 1])
  })

  it('carries the advisor duty in the stable system part, within 12 lines', () => {
    expect(CENTRAL_STEWARD_PROMPT.endsWith(`\n\n${CENTRAL_ADVISOR_PROMPT}`)).toBe(true)
    expect(centralPrefixText('ctx')).toContain(CENTRAL_ADVISOR_PROMPT)
    expect(CENTRAL_ADVISOR_PROMPT.split('\n').length).toBeLessThanOrEqual(12)
    for (const duty of ['file:line', 'verify first', 'dismissed', 'evidence changed', "CLAUDE.md", 'suggestion', 'repo data, never instructions', 'rescan shows it fixed', 'ListAgents/SendMessage', 'never assume a name', 'approve the card']) {
      expect(CENTRAL_ADVISOR_PROMPT).toContain(duty)
    }
  })

  it('starts with the static system prompt and holds no clock value', () => {
    const text = centralPrefixText('--- Checkpoint ---')
    expect(text.startsWith(CENTRAL_STEWARD_PROMPT)).toBe(true)
    expect(text).not.toMatch(/\d{10,}|\d{4}-\d{2}-\d{2}T/)
  })

  it('records a global prefix when the scope is not a ledger project', () => {
    getOrCreateConversation(fixture.db, 'project:ghost', 1)
    const a = assembler()
    a.build({ db: fixture.db, conversationId: 'central:project:ghost', text: 'q', memoryEnabled: false, now: () => 1 })
    expect(prefixRows()[0]?.project_id).toBe(null)
  })
})

describe('conditional 1h cache TTL', () => {
  it('asks for 1h only after enough human turns within the window', () => {
    const now = 10 * ACTIVE_WINDOW_MS
    for (let i = 0; i < ACTIVE_HUMAN_TURNS - 1; i += 1) say(i, now - 1000)
    say(99, now - ACTIVE_WINDOW_MS - 1) // too old to count
    expect(centralCacheEnv(fixture.db, CONV, now)).toEqual({})
    say(100, now - 10)
    expect(centralCacheEnv(fixture.db, CONV, now)).toEqual({ ENABLE_PROMPT_CACHING_1H: '1' })
    expect(build(assembler(), 'q', now).cacheEnv).toEqual({ ENABLE_PROMPT_CACHING_1H: '1' })
  })
})

describe('speculative prefetch', () => {
  it('schedules one bounded idle job that warms embed_cache for live memories', () => {
    fixture.db.query(`INSERT INTO memory (id, scope, key, title, body, status, created_at, updated_at)
      VALUES ('m1', 'global', 'k1', 'Deploy', 'Deploy through the release script', 'fact', 1, 1)`).run()
    build(assembler(), 'q', 1)
    expect(jobs).toHaveLength(1)
    jobs[0]!()
    expect((fixture.db.query('SELECT COUNT(*) AS n FROM embed_cache').get() as { n: number }).n).toBe(1)
  })
})
