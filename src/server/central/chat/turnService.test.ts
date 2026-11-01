import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { allRows, getRow } from '../../ledger/ledgerCore'
import { openFixture, seedPortfolio, type Fixture } from '../centralTestFixture.testutil'
import { appendConversationEvent, getConversation, getOrCreateConversation, getTurn, listConversationEvents } from '../conversationStore'
import { MockRuntime } from '../runtime/mockRuntime'
import { StreamHub, type StreamFrame } from './streamHub'
import { createPortfolioReadExecutor } from './toolExecutors'
import { CentralChatError, TurnService, listMessages } from './turnService'

const NOW = 1_700_000_000_000

let fixture: Fixture
let hub: StreamHub

beforeEach(() => {
  fixture = openFixture()
  seedPortfolio(fixture.db)
  getOrCreateConversation(fixture.db, 'global', NOW)
  hub = new StreamHub({
    replay: (id, after) => listConversationEvents(fixture.db, id, after, 500),
    heartbeatMs: 0,
  })
})
afterEach(() => {
  hub.close()
  fixture.close()
})

function service(mode: 'success' | 'cancel' = 'success', stepDelayMs = 0, chunks?: string[]): TurnService {
  const runtime = new MockRuntime({
    mode,
    stepDelayMs,
    ...(chunks === undefined ? {} : { chunks }),
    toolExecutor: createPortfolioReadExecutor(fixture.db, { now: () => NOW }),
  })
  return new TurnService({ db: fixture.db, runtime, stream: hub, now: () => NOW })
}

function count(table: string): number {
  return Number(getRow(fixture.db, `SELECT COUNT(*) AS c FROM ${table}`)?.['c'] ?? -1)
}

describe('turn lifecycle', () => {
  it('persists human + assistant messages, the turn, usage, and ordered events', async () => {
    const svc = service()
    const submitted = svc.submit({ conversationId: 'central:global', clientMessageId: 'c1', text: 'hello' })
    const turn = await submitted.done

    expect(submitted.response.status).toBe('running')
    expect(turn.status).toBe('succeeded')
    expect(turn.usage).toMatchObject({ inputTokens: 2 })
    expect((turn.usage as { outputTokens: number }).outputTokens).toBeGreaterThan(0)
    expect(count('central_message')).toBe(2)
    expect(count('central_turn')).toBe(1)
    const assistant = allRows(fixture.db, `SELECT * FROM central_message WHERE role = 'assistant'`)[0]!
    const parts = JSON.parse(String(assistant['parts_json'])) as { type: string; state?: string; text?: string }[]
    expect(parts[0]).toMatchObject({ type: 'text', text: 'mock[global] hello'.replace('global', submitted.response.turnId) })
    expect(parts.some((part) => part.type === 'tool' && part.state === 'succeeded')).toBe(true)
    expect(assistant['state']).toBe('complete')

    const events = listConversationEvents(fixture.db, 'central:global', 0, 500)
    const types = events.map((event) => event.type)
    expect(types.slice(0, 3)).toEqual(['message.created', 'turn.status', 'message.created'])
    expect(types).toContain('part.delta')
    expect(types).toContain('tool.requested')
    expect(types).toContain('tool.completed')
    expect(types.at(-1)).toBe('done')
    expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1))
  })

  it('replays the same clientMessageId without a second message or turn', async () => {
    const svc = service()
    const first = svc.submit({ conversationId: 'central:global', clientMessageId: 'same', text: 'one' })
    await first.done
    const replay = svc.submit({ conversationId: 'central:global', clientMessageId: 'same', text: 'one' })

    expect(replay.response).toEqual({ ...first.response, status: 'succeeded' })
    expect(count('central_message')).toBe(2)
    expect(count('central_turn')).toBe(1)
    expect((await replay.done).id).toBe(first.response.turnId)
  })

  it('rejects a second send while a turn is live and releases the lock on cancel', async () => {
    const svc = service('success', 100, ['a', 'b', 'c'])
    const first = svc.submit({ conversationId: 'central:global', clientMessageId: 'slow', text: 'slow' })
    let busy: CentralChatError | null = null
    try {
      svc.submit({ conversationId: 'central:global', clientMessageId: 'second', text: 'second' })
    } catch (err) {
      busy = err as CentralChatError
    }
    expect(busy?.code).toBe('conversation_busy')
    expect(busy?.status).toBe(409)
    expect((busy as CentralChatError & { activeTurnId?: string }).activeTurnId).toBe(first.response.turnId)
    expect(count('central_message')).toBe(2)

    const cancelled = await svc.cancel(first.response.turnId)
    expect(cancelled.status).toBe('cancelled')
    const third = svc.submit({ conversationId: 'central:global', clientMessageId: 'third', text: 'again' })
    expect((await third.done).status).toBe('succeeded')
  })

  it('cancel stores partial text and marks the assistant message cancelled', async () => {
    const svc = service('success', 20, ['ABC', 'DEF'])
    const submitted = svc.submit({ conversationId: 'central:global', clientMessageId: 'cancel-me', text: 'stop' })
    let requested = false
    hub.subscribe('central:global', 0, (frame: StreamFrame) => {
      if (frame.kind !== 'event' || frame.event !== 'part.delta' || requested) return
      requested = true
      void svc.cancel(submitted.response.turnId)
    })
    const turn = await submitted.done
    expect(turn.status).toBe('cancelled')
    expect(turn.partialText).toBe('ABC')
    const assistant = allRows(fixture.db, `SELECT * FROM central_message WHERE role = 'assistant'`)[0]!
    expect(assistant['state']).toBe('cancelled')
    expect(listConversationEvents(fixture.db, 'central:global', 0, 500).at(-1)?.type).toBe('done')
  })

  it('answers 503-shaped runtime_off instead of writing anything', () => {
    const svc = new TurnService({ db: fixture.db, runtime: null, stream: hub, now: () => NOW })
    let error: CentralChatError | null = null
    try {
      svc.submit({ conversationId: 'central:global', clientMessageId: 'x', text: 'x' })
    } catch (err) {
      error = err as CentralChatError
    }
    expect(error?.code).toBe('central_runtime_off')
    expect(error?.status).toBe(503)
    expect(count('central_message')).toBe(0)
  })
})

describe('portfolio.read tool and scope isolation', () => {
  it('reads the global projection, audits once, and never touches plan/task/goal', async () => {
    const before = {
      plan: count('plan'), item: count('plan_item'), task: count('task'),
      goal: getRow(fixture.db, `SELECT goal_json FROM project WHERE id = 'p1'`)?.['goal_json'],
    }
    const svc = service()
    const submitted = svc.submit({ conversationId: 'central:global', clientMessageId: 'read', text: 'portfolio?' })
    await submitted.done

    const audit = allRows(fixture.db, `SELECT * FROM event WHERE kind = 'central.tool'`)
    expect(audit).toHaveLength(1)
    const payload = JSON.parse(String(audit[0]!['payload_json'])) as Record<string, unknown>
    expect(payload['tool']).toBe('portfolio.read')
    expect(payload['ok']).toBe(true)
    expect(typeof payload['argsDigest']).toBe('string')
    expect(JSON.stringify(payload)).not.toContain('portfolio?')

    const completion = listConversationEvents(fixture.db, 'central:global', 0, 500)
      .find((event) => event.type === 'tool.completed')
    const output = (completion?.payload as { output: { total: number; projects: { id: string }[] } }).output
    expect(output.total).toBe(3)
    expect(output.projects.map((project) => project.id)).toContain('p1')

    expect(count('plan')).toBe(before.plan)
    expect(count('plan_item')).toBe(before.item)
    expect(count('task')).toBe(before.task)
    expect(getRow(fixture.db, `SELECT goal_json FROM project WHERE id = 'p1'`)?.['goal_json']).toBe(before.goal)
  })

  it('scopes a project conversation to that project and audits it with project_id', async () => {
    getOrCreateConversation(fixture.db, 'project:p1', NOW)
    const svc = service()
    const submitted = svc.submit({ conversationId: 'central:project:p1', clientMessageId: 'p1', text: 'this project?' })
    await submitted.done
    const audit = allRows(fixture.db, `SELECT * FROM event WHERE kind = 'central.tool'`)[0]!
    expect(audit['project_id']).toBe('p1')
    const completion = listConversationEvents(fixture.db, 'central:project:p1', 0, 500)
      .find((event) => event.type === 'tool.completed')
    expect((completion?.payload as { output: { project: { id: string } } }).output.project.id).toBe('p1')
  })
})

describe('history reads', () => {
  it('pages messages backwards with `before` and rejects invalid limits', async () => {
    const svc = service()
    await svc.submit({ conversationId: 'central:global', clientMessageId: 'h1', text: 'one' }).done
    await svc.submit({ conversationId: 'central:global', clientMessageId: 'h2', text: 'two' }).done
    const page = listMessages(fixture.db, 'central:global', { limit: 2 })
    expect(page.items.map((message) => message.seq)).toEqual([3, 4])
    expect(page.nextBefore).toBe(3)
    const older = listMessages(fixture.db, 'central:global', { limit: 2, before: 3 })
    expect(older.items.map((message) => message.seq)).toEqual([1, 2])
    expect(older.nextBefore).toBe(null)
    expect(() => listMessages(fixture.db, 'central:global', { limit: 0 })).toThrow(CentralChatError)
  })

  it('lists the global conversation first plus project ones', () => {
    getOrCreateConversation(fixture.db, 'project:p2', NOW)
    const summaries = allRows(fixture.db, 'SELECT id FROM central_conversation ORDER BY id')
    expect(summaries.length).toBe(2)
    expect(getConversation(fixture.db, 'central:global')?.id).toBe('central:global')
    expect(getTurn(fixture.db, 'missing')).toBe(null)
  })
})

describe('event history immutability', () => {
  it('keeps a monotonic event seq even when a turn fails', async () => {
    appendConversationEvent(fixture.db, { conversationId: 'central:global', type: 'error', payload: { code: 'x' } })
    const svc = service()
    const submitted = svc.submit({ conversationId: 'central:global', clientMessageId: 'f', text: 'fail' })
    await submitted.done
    const seqs = listConversationEvents(fixture.db, 'central:global', 0, 500).map((event) => event.seq)
    expect(seqs).toEqual(seqs.map((_, index) => index + 1))
  })
})
