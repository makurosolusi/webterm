import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { openFixture, seedPortfolio, type Fixture } from '../../centralTestFixture.testutil'
import { registerCa2Tools } from '../registerAll'
import { ALLOW_ALL_GUARD, execTool } from '../toolExec'
import { createRegistry } from '../toolRegistry'
import type { Tier, ToolCtx } from '../toolTypes'
import { REMINDER_DEFS } from './reminder.defs'

const NOW = 1_700_000_000_000
const MINUTE = 60_000
const GLOBAL = 'central:global'
const PROJECT = 'central:project:p1'
let f: Fixture
beforeEach(() => { f = openFixture(); seedPortfolio(f.db) })
afterEach(() => f.close())

function ctx(conversationId = GLOBAL, maxTier: Tier = 'R1'): ToolCtx {
  const registry = createRegistry()
  for (const def of REMINDER_DEFS) registry.register(def)
  return { db: f.db, registry, guard: ALLOW_ALL_GUARD, maxTier, conversationId, now: () => NOW, env: {} }
}
const stored = (id: unknown) => f.db.query('SELECT * FROM central_reminder WHERE id = ?').get(id as string) as Record<string, unknown>

describe('reminder tools', () => {
  it('registers with Central at the agreed tiers', () => {
    expect(REMINDER_DEFS.map((d) => [d.name, d.tier])).toEqual([['reminder.set', 'R1'], ['reminder.list', 'R0'], ['reminder.cancel', 'R1']])
    expect(registerCa2Tools(createRegistry(), {}, { WEBTERM_CENTRAL: 'on' })).toEqual(expect.arrayContaining(['reminder.set', 'reminder.list', 'reminder.cancel']))
  })

  it('stores inMinutes and at, with the text redacted', async () => {
    const secret = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789' // test-only
    const r = await execTool(ctx(), 'reminder.set', { inMinutes: 10, text: `check ${secret}` })
    expect(r.ok).toBe(true)
    expect(r.data?.dueAt).toBe(NOW + 10 * MINUTE)
    const row = stored(r.data?.id)
    expect(String(row.text)).not.toContain(secret)
    expect(row).toMatchObject({ status: 'pending', created_by: 'central', conversation_id: GLOBAL })
    const at = new Date(NOW + 2 * MINUTE).toISOString()
    expect((await execTool(ctx(), 'reminder.set', { at, text: 'x' })).data?.dueAt).toBe(NOW + 2 * MINUTE)
  })

  it('enforces 1 minute to 90 days and exactly one time field', async () => {
    const c = ctx()
    const over = new Date(NOW + 90 * 1440 * MINUTE + 1).toISOString()
    const under = new Date(NOW + MINUTE - 1).toISOString()
    for (const input of [{ at: over, text: 'x' }, { at: under, text: 'x' }, { at: 'tomorrow', text: 'x' }, { text: 'x' }, { inMinutes: 5, at: new Date(NOW + 5 * MINUTE).toISOString(), text: 'x' }]) {
      expect(await execTool(c, 'reminder.set', input)).toMatchObject({ ok: false, code: 'invalid_due' })
    }
    expect((await execTool(c, 'reminder.set', { inMinutes: 0, text: 'x' })).ok).toBe(false)
    expect((await execTool(c, 'reminder.set', { inMinutes: 90 * 1440 + 1, text: 'x' })).ok).toBe(false)
    expect((await execTool(c, 'reminder.set', { inMinutes: 90 * 1440, text: 'x' })).ok).toBe(true)
    expect(await execTool(c, 'reminder.set', { inMinutes: 5, text: '  ' })).toMatchObject({ ok: false, code: 'invalid_shape' })
  })

  it('a project chat stays in its project', async () => {
    const own = await execTool(ctx(PROJECT), 'reminder.set', { inMinutes: 5, text: 'mine' })
    expect(stored(own.data?.id).project_id).toBe('p1')
    expect(await execTool(ctx(PROJECT), 'reminder.set', { inMinutes: 5, text: 'x', projectId: 'p2' })).toMatchObject({ ok: false, code: 'conversation_project_mismatch' })
    const other = await execTool(ctx(), 'reminder.set', { inMinutes: 5, text: 'theirs', projectId: 'p2' })
    expect(((await execTool(ctx(PROJECT), 'reminder.list', {})).data?.items as unknown[]).length).toBe(1)
    expect(await execTool(ctx(PROJECT), 'reminder.cancel', { id: other.data?.id })).toMatchObject({ ok: false, code: 'reminder_not_found' })
    expect(await execTool(ctx(), 'reminder.set', { inMinutes: 5, text: 'x', projectId: 'ghost' })).toMatchObject({ ok: false, code: 'project_not_found' })
    expect(await execTool(ctx(), 'reminder.set', { inMinutes: 5, text: 'x', taskId: 'ghost' })).toMatchObject({ ok: false, code: 'task_not_found' })
  })

  it('lists with pages and cancels once', async () => {
    const c = ctx()
    const ids: unknown[] = []
    for (const m of [30, 10, 20]) ids.push((await execTool(c, 'reminder.set', { inMinutes: m, text: `m${m}` })).data?.id)
    const page = await execTool(c, 'reminder.list', { limit: 2 })
    expect((page.data?.items as { text: string }[]).map((i) => i.text)).toEqual(['m10', 'm20'])
    expect(page.data?.hasMore).toBe(true)
    expect(await execTool(c, 'reminder.cancel', { id: ids[1] })).toMatchObject({ ok: true, data: { status: 'cancelled' } })
    expect(await execTool(c, 'reminder.cancel', { id: ids[1] })).toMatchObject({ ok: false, code: 'reminder_not_pending' })
    expect(await execTool(c, 'reminder.cancel', { id: 'nope' })).toMatchObject({ ok: false, code: 'reminder_not_found' })
    expect((await execTool(c, 'reminder.list', {})).data?.items).toMatchObject([{ text: 'm20' }, { text: 'm30' }, { text: 'm10', status: 'cancelled' }])
  })
})
