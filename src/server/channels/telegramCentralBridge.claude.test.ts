import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openFixture, seedPortfolio, type Fixture } from '../central/centralTestFixture.testutil'
import { StreamHub } from '../central/chat/streamHub'
import { TurnService } from '../central/chat/turnService'
import { ClaudeRuntime } from '../central/runtime/claudeRuntime'
import type { ClaudeReady } from '../central/runtime/claudeOptions'
import { successRecords } from '../central/runtime/claude.fakeBin'
import { type FakePlay, fakeQuery } from '../central/runtime/claude.fakeQuery'
import { createTelegramCentralPort } from './telegramCentralBridge'

// Far above any in-process turn, far below the bridge TIMEOUT_MS (120 s): proves no timeout wait.
const FAST_MS = 5_000

let fixture: Fixture
let dir: string

beforeEach(() => {
  fixture = openFixture()
  seedPortfolio(fixture.db)
  dir = mkdtempSync(join(tmpdir(), 'tg-claude-'))
})
afterEach(() => {
  fixture.close()
  rmSync(dir, { recursive: true, force: true })
})

function portWith(play: FakePlay, preflight: () => Promise<ClaudeReady>) {
  const runtime = new ClaudeRuntime({ query: fakeQuery(play).query, workDir: join(dir, 'work'), preflight })
  const service = new TurnService({ db: fixture.db, runtime, stream: new StreamHub() })
  return createTelegramCentralPort({ db: fixture.db, kind: 'claude', service })
}

describe('telegram central bridge with the claude runtime', () => {
  it('answers fast with central_runtime_unavailable when the CLI is not ready', async () => {
    const port = portWith([], async () => ({ ok: false, code: 'claude_not_found', hint: 'missing' }))
    const started = Date.now()
    const result = await port.ask({ projectId: 'p1', text: 'hello', updateId: 10 })
    expect(result).toEqual({ ok: false, code: 'central_runtime_unavailable' })
    expect(Date.now() - started).toBeLessThan(FAST_MS)
  })

  it('returns the answer text when claude is ready', async () => {
    const port = portWith(successRecords(), async () => ({ ok: true }))
    const result = await port.ask({ projectId: 'p1', text: 'hello', updateId: 11 })
    expect(result).toEqual({ ok: true, text: 'Hello world' })
  })

  it('keeps other failures on the generic codes', async () => {
    const port = portWith(async function* () { yield* []; throw new Error('Claude Code process exited with code 3') }, async () => ({ ok: true }))
    const result = await port.ask({ projectId: 'p1', text: 'hello', updateId: 12 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).not.toBe('central_runtime_unavailable')
  })
})
