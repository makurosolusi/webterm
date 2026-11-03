import type { Database } from 'bun:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openFixture, seedPortfolio } from '../central/centralTestFixture.testutil'
import { TurnService } from '../central/chat/turnService'
import { StreamHub } from '../central/chat/streamHub'
import { registerWorkspaceLookup } from '../central/chat/turnPersistence'
import type { CentralRuntime, RuntimeEmit, RuntimeResult, TurnInput } from '../central/runtime/centralRuntime'
import { centralTelegramEnabled, createTelegramCentralPort } from './telegramCentralBridge'

function makeService(db: Database, runtime: CentralRuntime, now = () => Date.now()): TurnService {
  return new TurnService({ db, runtime, stream: new StreamHub(), now })
}

class BlockingRuntime implements CentralRuntime {
  readonly kind = 'mock' as const
  resolve!: () => void
  async turn(input: TurnInput, _emit: RuntimeEmit): Promise<RuntimeResult> {
    await new Promise<void>((resolve) => { this.resolve = resolve })
    return {
      turnId: input.turnId,
      outcome: 'success',
      text: 'released',
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costMicros: 0, durationMs: 0 },
    }
  }
  cancel(): boolean { return false }
  async close(): Promise<void> {}
}

describe('telegram central bridge', () => {
  afterEach(() => vi.useRealTimers())

  it.each([
    ['on', 'on', true],
    ['ON', ' on ', true],
    ['on', 'off', false],
    ['off', 'on', false],
    ['', 'on', false],
    ['garbage', 'garbage', false],
  ])('gates central Telegram for central=%j telegram=%j', (central, telegram, expected) => {
    expect(centralTelegramEnabled({ WEBTERM_CENTRAL: central, WEBTERM_TELEGRAM: telegram })).toBe(expected)
  })

  it('answers mock chat and persists conversation and turn rows', async () => {
    const fixture = openFixture()
    try {
      seedPortfolio(fixture.db)
      const port = createTelegramCentralPort({ db: fixture.db, kind: 'mock' })
      const result = await port.ask({ projectId: 'p1', text: 'hello', updateId: 1 })
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.text).not.toBe('')
      expect(fixture.db.query('SELECT COUNT(*) AS count FROM central_message').get()).toMatchObject({ count: 2 })
      expect(fixture.db.query('SELECT COUNT(*) AS count FROM central_turn').get()).toMatchObject({ count: 1 })
    } finally { fixture.close() }
  })

  it('deduplicates the same Telegram update', async () => {
    const fixture = openFixture()
    try {
      seedPortfolio(fixture.db)
      const port = createTelegramCentralPort({ db: fixture.db, kind: 'mock' })
      const first = await port.ask({ projectId: 'p1', text: 'hello', updateId: 2 })
      const second = await port.ask({ projectId: 'p1', text: 'hello', updateId: 2 })
      expect(second).toEqual(first)
      expect(fixture.db.query("SELECT COUNT(*) AS count FROM central_message WHERE role = 'human'").get()).toMatchObject({ count: 1 })
      expect(fixture.db.query('SELECT COUNT(*) AS count FROM central_turn').get()).toMatchObject({ count: 1 })
    } finally { fixture.close() }
  })

  it('returns runtime off without throwing', async () => {
    const fixture = openFixture()
    try {
      const port = createTelegramCentralPort({ db: fixture.db, kind: 'off' })
      await expect(port.ask({ projectId: 'p1', text: 'hello', updateId: 3 })).resolves.toEqual({ ok: false, code: 'central_runtime_off' })
    } finally { fixture.close() }
  })

  it('reports busy while the first turn is blocked', async () => {
    const fixture = openFixture()
    const runtime = new BlockingRuntime()
    try {
      seedPortfolio(fixture.db)
      const port = createTelegramCentralPort({ db: fixture.db, kind: 'mock', service: makeService(fixture.db, runtime) })
      const first = port.ask({ projectId: 'p1', text: 'first', updateId: 4 })
      await Promise.resolve()
      await Promise.resolve()
      expect(runtime.resolve).toBeTypeOf('function')
      await expect(port.ask({ projectId: 'p1', text: 'second', updateId: 5 })).resolves.toEqual({ ok: false, code: 'conversation_busy' })
      runtime.resolve()
      await first
    } finally { fixture.close() }
  })

  it('returns central_timeout after 120 seconds', async () => {
    vi.useFakeTimers()
    const fixture = openFixture()
    const runtime = new BlockingRuntime()
    try {
      seedPortfolio(fixture.db)
      const port = createTelegramCentralPort({ db: fixture.db, kind: 'mock', service: makeService(fixture.db, runtime) })
      const pending = port.ask({ projectId: 'p1', text: 'slow', updateId: 6 })
      await vi.advanceTimersByTimeAsync(120_000)
      await expect(pending).resolves.toEqual({ ok: false, code: 'central_timeout' })
      runtime.resolve()
    } finally { fixture.close() }
  })
})

describe('telegram central bridge: workspace-id binding', () => {
  // test-only workspace store: one workspace the ledger has never seen.
  const workspaces: Record<string, { name: string; cwd?: string }> = { 'ws-1': { name: 'wibu', cwd: '/tmp/wibu' } }
  let unregister: (() => void) | undefined
  afterEach(() => unregister?.())
  const projects = (db: Database, workspaceId: string) =>
    db.query('SELECT id, name, path FROM project WHERE workspace_id = ?').all(workspaceId)

  it('creates the ledger project once from the workspace, then answers', async () => {
    unregister = registerWorkspaceLookup((id) => workspaces[id] ?? null)
    const fixture = openFixture()
    try {
      const port = createTelegramCentralPort({ db: fixture.db, kind: 'mock' })
      const first = await port.ask({ projectId: 'ws-1', text: 'hello', updateId: 10 })
      expect(first.ok).toBe(true)
      const second = await port.ask({ projectId: 'ws-1', text: 'again', updateId: 11 })
      expect(second.ok).toBe(true)
      expect(projects(fixture.db, 'ws-1')).toEqual([{ id: 'ws-1', name: 'wibu', path: '/tmp/wibu' }])
      expect(fixture.db.query('SELECT COUNT(*) AS count FROM central_turn').get()).toMatchObject({ count: 2 })
    } finally { fixture.close() }
  })

  it('maps a workspace id to the ledger project already linked to it', async () => {
    unregister = registerWorkspaceLookup(() => null)
    const fixture = openFixture()
    try {
      seedPortfolio(fixture.db) // p1 has workspace_id w-p1
      const port = createTelegramCentralPort({ db: fixture.db, kind: 'mock' })
      const result = await port.ask({ projectId: 'w-p1', text: 'hello', updateId: 12 })
      expect(result.ok).toBe(true)
      expect(fixture.db.query('SELECT id FROM central_conversation').all()).toEqual([{ id: 'central:project:p1' }])
      expect(fixture.db.query('SELECT COUNT(*) AS count FROM project').get()).toMatchObject({ count: 3 })
    } finally { fixture.close() }
  })

  it('still rejects an id that is neither a project nor a workspace', async () => {
    unregister = registerWorkspaceLookup((id) => workspaces[id] ?? null)
    const fixture = openFixture()
    try {
      const port = createTelegramCentralPort({ db: fixture.db, kind: 'mock' })
      await expect(port.ask({ projectId: 'ws-missing', text: 'hello', updateId: 13 }))
        .resolves.toEqual({ ok: false, code: 'project_not_found' })
      expect(fixture.db.query('SELECT COUNT(*) AS count FROM project').get()).toMatchObject({ count: 0 })
    } finally { fixture.close() }
  })
})
