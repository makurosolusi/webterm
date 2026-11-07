// A stale Claude resume id must heal inside one turn: the runtime retries in a fresh session, the
// reply carries the notice, the new session id is stored, and the human message is recorded once.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openFixture, seedPortfolio, type Fixture } from '../centralTestFixture.testutil'
import {
  appendMessage, createTurn, getOrCreateConversation, listConversationEvents, sessionRefFor, updateTurn,
} from '../conversationStore'
import { ClaudeRuntime } from '../runtime/claudeRuntime'
import { createCentralMcpLink } from '../runtime/claudeMcp'
import { initRecord, resultRecord, writeFakeClaude } from '../runtime/claude.fakeBin'
import { listMessages } from './turnPersistence'
import { StreamHub } from './streamHub'
import { TurnService } from './turnService'

const NOW = 1_700_000_000_000
const NOTICE = 'Started a fresh Claude session; the previous one was no longer available.'
let fixture: Fixture
let hub: StreamHub
let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fresh-session-'))
  fixture = openFixture()
  seedPortfolio(fixture.db)
  getOrCreateConversation(fixture.db, 'global', NOW)
  hub = new StreamHub({ replay: (id, after) => listConversationEvents(fixture.db, id, after, 500), heartbeatMs: 0 })
})
afterEach(() => {
  hub.close()
  fixture.close()
  rmSync(dir, { recursive: true, force: true })
})

/** Fails `--resume stale…` exactly like Claude Code 2.1.319 print mode; answers "hi" in a fresh session. */
function fakeClaude(): { exe: string; spawns: () => string[][] } {
  const log = join(dir, 'spawns.jsonl')
  const failed = resultRecord({ subtype: 'error_during_execution', is_error: true, duration_ms: 0 })
  const exe = writeFakeClaude(dir, `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n')
readStdin()
const at = process.argv.indexOf('--resume')
if (at >= 0 && process.argv[at + 1].startsWith('stale')) {
  emit({ ...${JSON.stringify(failed)}, errors: ['No conversation found with session ID: ' + process.argv[at + 1]] })
  process.exit(1)
}
const sid = at >= 0 ? process.argv[at + 1] : process.argv[process.argv.indexOf('--session-id') + 1]
emit({ ...${JSON.stringify(initRecord())}, session_id: sid })
emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } } })
emit({ ...${JSON.stringify(resultRecord())}, session_id: sid })`)
  return { exe, spawns: () => readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[]) }
}

/** A succeeded Claude turn whose session Claude no longer has. */
function seedStaleClaudeSession(ref: string): void {
  const m = appendMessage(fixture.db, { conversationId: 'central:global', role: 'human', parts: [{ type: 'text', text: 'old' }], now: NOW }).message
  const turn = createTurn(fixture.db, { conversationId: 'central:global', messageId: m.id, runtime: 'claude', now: NOW })
  updateTurn(fixture.db, { turnId: turn.id, status: 'succeeded', sessionRef: ref, now: NOW })
}

describe('stale Claude session', () => {
  it('heals in one turn: success, notice on the reply, new id stored, no loop', async () => {
    seedStaleClaudeSession('stale-claude-session')
    const { exe, spawns } = fakeClaude()
    let ids = 0
    const runtime = new ClaudeRuntime({
      executable: exe, workDir: join(dir, 'work'), env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir },
      killGraceMs: 50, newSessionId: () => `fresh-${++ids}`,
      // test-only token
      mcp: createCentralMcpLink({ dir: join(dir, 'mcp'), port: 1, mint: () => ({ token: 'wcap_test-only', revoke: () => undefined }) }),
    })
    const svc = new TurnService({ db: fixture.db, runtime, stream: hub, now: () => NOW })

    const turn = await svc.submit({ conversationId: 'central:global', clientMessageId: 'c1', text: 'hello' }).done
    expect(turn.status).toBe('succeeded')
    expect(spawns()).toHaveLength(2)
    expect(sessionRefFor(fixture.db, 'central:global', 'claude')).toBe('fresh-2')

    const messages = listMessages(fixture.db, 'central:global').items
    expect(messages.filter((m) => m.role === 'human' && JSON.stringify(m.parts).includes('hello'))).toHaveLength(1)
    const reply = messages.at(-1)!
    expect(reply.parts).toEqual([{ type: 'notice', text: NOTICE }, { type: 'text', text: 'hi' }])
    const events = listConversationEvents(fixture.db, 'central:global', 0, 500)
    expect(events.filter((e) => e.type === 'notice')).toHaveLength(1)
    expect(events.some((e) => e.type === 'error')).toBe(false)

    // The next turn resumes the new session directly: one spawn, no notice.
    await svc.submit({ conversationId: 'central:global', clientMessageId: 'c2', text: 'again' }).done
    const runs = spawns()
    expect(runs).toHaveLength(3)
    expect(runs[2]![runs[2]!.indexOf('--resume') + 1]).toBe('fresh-2')
  })
})
