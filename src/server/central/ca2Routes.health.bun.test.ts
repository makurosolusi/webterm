import { describe, expect, it } from 'bun:test'
import type { FindingDraft } from '../../shared/centralHealth'
import type { Ca2Handle } from './ca2Boot'
import { healthDispatch, isHealthPath } from './ca2Routes.health'
import { freshDb, T0 } from './guard/controlGuard.testutil'
import { createHealthStore } from './health/healthStore'

const HUMAN = 'human:root'
const B = '/api/central/health'

const draft = (fp: string, over: Partial<FindingDraft> = {}): FindingDraft => ({
  rule: 'file_size', severity: 'medium', confidence: 'high', file: `${fp}.ts`, line: 1, title: `big ${fp}`,
  evidence: '600 lines', source: 'CLAUDE.md Rule 8', suggestion: 'split it', fingerprint: fp, ...over,
})

function rig() {
  const db = freshDb()
  db.exec(`INSERT INTO central_task (id, project_id, title, objective, created_by, created_at, updated_at) VALUES ('t1', 'p1', 't', 'o', 'central', 0, 0)`)
  const h = { db, now: () => T0 } as unknown as Ca2Handle
  const store = createHealthStore(db, () => T0)
  const s = store.startScan('p1', 'scan')
  store.finishScan(s.id, {
    drafts: [draft('a', { severity: 'high', evidence: 'key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789' }), draft('b'), draft('c', { rule: 'empty_catch', severity: 'low' })], // test-only secret
    rules: ['file_size', 'empty_catch'], filesScanned: 3, truncated: false,
  })
  const r = store.startScan('p1', 'review')
  store.finishScan(r.id, { drafts: [draft('d')], rules: ['file_size'], filesScanned: 1, truncated: false, taskId: 't1' })
  const call = (method: string, path: string, q = '', body: unknown = {}, actor = HUMAN) =>
    healthDispatch(h, { method, path, query: new URLSearchParams(q), body: async () => body }, actor)
  const ids = (res: { body: unknown }) => (res.body as { items: { fingerprint: string }[] }).items.map((f) => f.fingerprint)
  return { db, store, call, ids }
}

describe('health routes', () => {
  it('claims exactly its paths', () => {
    for (const p of [`${B}/summary`, `${B}/findings`, `${B}/scan`, `${B}/findings/f/dismiss`, `${B}/findings/f/reopen`]) expect(isHealthPath(p)).toBe(true)
    expect(isHealthPath(`${B}/findings/f`)).toBe(false)
    expect(isHealthPath(`${B}/findings/f/fix`)).toBe(false)
  })

  it('summarises a project with its running flag', async () => {
    const r = rig()
    const res = await r.call('GET', `${B}/summary`, 'projectId=p1')
    expect(res).toMatchObject({ status: 200, body: { open: 4, high: 1, medium: 2, low: 1, running: false } })
    expect((await r.call('GET', `${B}/summary`, 'projectId=ghost')).status).toBe(404)
    expect((await r.call('GET', `${B}/summary`, 'projectId=a b')).status).toBe(400)
    expect((await r.call('GET', `${B}/summary`)).status).toBe(400)
  })

  it('lists findings with filters, pages and redacted evidence', async () => {
    const r = rig()
    const all = await r.call('GET', `${B}/findings`, 'projectId=p1')
    expect(r.ids(all)[0]).toBe('a')
    expect(JSON.stringify(all.body)).not.toContain('sk-ant-api03')
    expect(r.ids(await r.call('GET', `${B}/findings`, 'projectId=p1&severity=high,low'))).toEqual(['a', 'c'])
    expect(r.ids(await r.call('GET', `${B}/findings`, 'projectId=p1&rule=empty_catch'))).toEqual(['c'])
    expect(r.ids(await r.call('GET', `${B}/findings`, 'taskId=t1'))).toEqual(['d'])
    expect(r.ids(await r.call('GET', `${B}/findings`, 'projectId=p1&origin=review'))).toEqual(['d'])
    expect(r.ids(await r.call('GET', `${B}/findings`, 'projectId=p1&origin=scan,analysis')).sort()).toEqual(['a', 'b', 'c'])
    const page = await r.call('GET', `${B}/findings`, 'projectId=p1&limit=2')
    expect((page.body as { hasMore: boolean }).hasMore).toBe(true)
    expect(r.ids(await r.call('GET', `${B}/findings`, 'projectId=p1&limit=2&offset=2')).length).toBe(2)
    for (const [q, error] of [['', 'invalid_project'], ['projectId=p1&status=gone', 'invalid_status'], ['projectId=p1&severity=x', 'invalid_severity'],
      ['projectId=p1&rule=x', 'invalid_rule'], ['projectId=p1&origin=x', 'invalid_origin'], ['taskId=a%20b', 'invalid_task'], ['projectId=p1&limit=0', 'invalid_page']]) {
      expect(await r.call('GET', `${B}/findings`, q)).toEqual({ status: 400, body: { error } })
    }
    expect((await r.call('GET', `${B}/findings`, 'taskId=ghost')).status).toBe(404)
    expect((await r.call('GET', `${B}/findings`, 'projectId=ghost')).status).toBe(404)
  })

  it('dismisses with a reason and reopens; maps store errors', async () => {
    const r = rig()
    const id = r.store.list({ projectId: 'p1' })[0]!.id
    expect(await r.call('POST', `${B}/findings/${id}/dismiss`, '', { reason: '  ' })).toEqual({ status: 400, body: { error: 'invalid_reason' } })
    expect(await r.call('POST', `${B}/findings/${id}/dismiss`)).toEqual({ status: 400, body: { error: 'invalid_reason' } })
    const done = await r.call('POST', `${B}/findings/${id}/dismiss`, '', { reason: 'generated file' })
    expect(done).toMatchObject({ status: 200, body: { id, status: 'dismissed', dismissedReason: 'generated file', dismissedBy: HUMAN } })
    expect((await r.call('POST', `${B}/findings/${id}/dismiss`, '', { reason: 'again' })).status).toBe(409)
    expect(await r.call('POST', `${B}/findings/${id}/reopen`)).toMatchObject({ status: 200, body: { status: 'open', dismissedReason: null } })
    expect((await r.call('POST', `${B}/findings/${id}/reopen`)).status).toBe(409)
    expect(await r.call('POST', `${B}/findings/nope/reopen`)).toEqual({ status: 404, body: { error: 'finding_not_found' } })
    expect((await r.call('POST', `${B}/findings/a%20b/reopen`)).status).toBe(400)
    expect((await r.call('GET', `${B}/findings/${id}/reopen`)).status).toBe(405)
  })

  it('starts a scan without awaiting it and refuses a second one', async () => {
    const r = rig()
    const res = await r.call('POST', `${B}/scan`, '', { projectId: 'p2' })
    expect(res).toMatchObject({ status: 202, body: { projectId: 'p2', status: 'running', origin: 'scan' } })
    expect(await r.call('POST', `${B}/scan`, '', { projectId: 'p2' })).toEqual({ status: 409, body: { error: 'scan_running' } })
    expect((await r.call('GET', `${B}/summary`, 'projectId=p2')).body).toMatchObject({ running: true })
    expect((await r.call('POST', `${B}/scan`, '', { projectId: 'ghost' })).status).toBe(404)
    expect((await r.call('POST', `${B}/scan`, '', {})).status).toBe(400)
    expect((await r.call('GET', `${B}/scan`)).status).toBe(405)
  })

  it('writes are human-only', async () => {
    const r = rig()
    const id = r.store.list({ projectId: 'p1' })[0]!.id
    expect(await r.call('POST', `${B}/findings/${id}/dismiss`, '', { reason: 'x' }, 'central')).toEqual({ status: 403, body: { error: 'human_only' } })
    expect((await r.call('POST', `${B}/scan`, '', { projectId: 'p1' }, 'agent:x')).status).toBe(403)
    expect(r.store.get(id)?.status).toBe('open')
  })
})
