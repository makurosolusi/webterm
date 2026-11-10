import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openFixture, seedPortfolio, type Fixture } from '../centralTestFixture.testutil'
import { appendMessage, getOrCreateConversation } from '../conversationStore'
import { createWorkStore } from '../work/workStore'
import { collectFacts, insertCheckpoint, latestCheckpoint } from './checkpointStore'
import { FALLBACK_MESSAGES, createCheckpoint, createFallbackCheckpoint, type Summarize } from './checkpointSummarizer'

const CONV = 'central:project:p1'
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
const ok: Summarize = async () => ({ narrative: 'Intent: ship\nBerikutnya: test', model: 'm1', usage: { inputTokens: 5 } })

describe('collectFacts', () => {
  it('is deterministic and ledger-derived, scoped to the project', () => {
    const a = collectFacts(fixture.db, CONV)
    expect(collectFacts(fixture.db, CONV)).toBe(a)
    const facts = JSON.parse(a)
    expect(Object.keys(facts)).toEqual(['activeTasks', 'lastProposal', 'openWork', 'pendingApprovals', 'projectId', 'schemaV'])
    expect(facts.projectId).toBe('p1')
    expect(facts.pendingApprovals.map((x: { id: string }) => x.id)).toEqual(['a-expired', 'a-live'])
    expect(facts.activeTasks).toEqual([{ id: 't-pending', status: 'pending' }])
  })

  it('names the open board tasks of the project, not the closed ones or another project', () => {
    const store = createWorkStore(fixture.db, () => 1)
    store.createTask({ id: 'w-open', projectId: 'p1', title: 'build it', objective: 'o', actor: { kind: 'central' } })
    store.createTask({ id: 'w-gone', projectId: 'p1', title: 'dropped', objective: 'o', actor: { kind: 'central' } })
    store.moveTask('w-gone', 'cancelled', { actor: { kind: 'central' } })
    store.createTask({ id: 'w-other', projectId: 'p2', title: 'elsewhere', objective: 'o', actor: { kind: 'central' } })
    expect(JSON.parse(collectFacts(fixture.db, CONV)).openWork).toEqual([{ id: 'w-open', status: 'todo', title: 'build it' }])
  })

  it('records the newest tool card as lastProposal', () => {
    appendMessage(fixture.db, {
      conversationId: CONV, role: 'assistant', now: 3,
      parts: [{ type: 'tool', toolCallId: 'c1', name: 'plan.item.add', state: 'succeeded' }],
    })
    expect(JSON.parse(collectFacts(fixture.db, CONV)).lastProposal).toEqual({ name: 'plan.item.add', state: 'succeeded' })
  })
})

describe('createCheckpoint', () => {
  it('stores an auto checkpoint with narrative, model and usage', async () => {
    const first = say('hello'); say('world', 2)
    const cp = await createCheckpoint({ db: fixture.db, conversationId: CONV, summarize: ok, now: () => 9 })
    expect(cp).toMatchObject({ seq: 1, source: 'auto', fromMessageId: first, narrative: 'Intent: ship\nBerikutnya: test' })
    const row = fixture.db.query('SELECT model, usage_json FROM central_checkpoint').get() as { model: string; usage_json: string }
    expect(row.model).toBe('m1')
    expect(JSON.parse(row.usage_json)).toEqual({ inputTokens: 5 })
  })

  it('anchors the next checkpoint on the previous one and only summarizes new messages', async () => {
    say('one'); await createCheckpoint({ db: fixture.db, conversationId: CONV, summarize: ok, now: () => 9 })
    say('two', 2)
    let seen: readonly string[] = []
    const spy: Summarize = async (input) => {
      seen = input.messages.map((m) => m.text)
      expect(input.previousNarrative).toBe('Intent: ship\nBerikutnya: test')
      return { narrative: 'second' }
    }
    const cp = await createCheckpoint({ db: fixture.db, conversationId: CONV, summarize: spy, now: () => 10 })
    expect(seen).toEqual(['two'])
    expect(cp?.seq).toBe(2)
  })

  it('returns the existing checkpoint without calling the summarizer when nothing is new', async () => {
    say('one'); const first = await createCheckpoint({ db: fixture.db, conversationId: CONV, summarize: ok, now: () => 9 })
    const never: Summarize = async () => { throw new Error('must not run') }
    expect(await createCheckpoint({ db: fixture.db, conversationId: CONV, summarize: never, now: () => 10 })).toEqual(first)
  })

  it('falls back to facts + message heads when the summarizer throws', async () => {
    for (let i = 0; i < 9; i += 1) say(`msg ${i} ${'y'.repeat(300)}`, i)
    const boom: Summarize = async () => { throw new Error('model down') }
    const cp = await createCheckpoint({ db: fixture.db, conversationId: CONV, summarize: boom, now: () => 9 })
    expect(cp?.source).toBe('fallback')
    const lines = cp?.narrative.split('\n') ?? []
    expect(lines).toHaveLength(FALLBACK_MESSAGES)
    expect(lines[0]).toContain('msg 3')
    expect(lines.every((l) => l.length <= 'human: '.length + 200)).toBe(true)
    expect(cp?.factsJson).toBe(collectFacts(fixture.db, CONV))
  })

  it('falls back on timeout and aborts the summarizer', async () => {
    say('one')
    let aborted = false
    const slow: Summarize = (_input, signal) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')) })
    })
    const cp = await createCheckpoint({ db: fixture.db, conversationId: CONV, summarize: slow, now: () => 9, timeoutMs: 20 })
    expect(cp?.source).toBe('fallback')
    expect(aborted).toBe(true)
  })

  it('falls back on an empty narrative', async () => {
    say('one')
    const cp = await createCheckpoint({ db: fixture.db, conversationId: CONV, summarize: async () => ({ narrative: '  ' }), now: () => 9 })
    expect(cp?.source).toBe('fallback')
  })

  it('returns null for an empty conversation', async () => {
    expect(await createCheckpoint({ db: fixture.db, conversationId: CONV, summarize: ok, now: () => 9 })).toBeNull()
  })
})

describe('insertCheckpoint', () => {
  it('redacts secrets, caps the narrative at 1500 chars and increments seq', () => {
    const base = { conversationId: CONV, fromMessageId: null, toMessageId: null, factsJson: '{}', source: 'manual' as const, now: 1 }
    const one = insertCheckpoint(fixture.db, { ...base, narrative: `key sk-ant-api03-${'a'.repeat(40)} ${'z'.repeat(2000)}` })
    expect(one.narrative.length).toBe(1500)
    expect(one.narrative).not.toContain('sk-ant-api03')
    expect(insertCheckpoint(fixture.db, { ...base, narrative: 'two' }).seq).toBe(2)
    expect(latestCheckpoint(fixture.db, CONV)?.narrative).toBe('two')
  })

  it('createFallbackCheckpoint is idempotent until new messages arrive', () => {
    say('one')
    const a = createFallbackCheckpoint(fixture.db, CONV, 5)
    expect(createFallbackCheckpoint(fixture.db, CONV, 6)?.id).toBe(a?.id)
    say('two', 2)
    expect(createFallbackCheckpoint(fixture.db, CONV, 7)?.seq).toBe(2)
  })
})
