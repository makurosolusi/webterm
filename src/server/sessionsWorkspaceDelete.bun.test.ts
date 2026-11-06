// Bun-only (bun:sqlite via `openDb`). Locks ops-212-3: deleting a workspace ends the sessions of its
// nodes server-side, panes included, even with no browser open to send `close`.
import { test, expect } from 'bun:test'
import type { WsNode } from '../shared/workspace'
import { Db, openDb } from './db'
import { workspacesRoute } from './workspacesApi'
import { sessions } from './sessions'
import { FakePty } from './fakePty.testutil'

test('DELETE of a workspace ends the live sessions of its nodes and panes, and only those', async () => {
  const ptys: FakePty[] = []
  sessions.options = { spawn: () => { const p = new FakePty(); ptys.push(p); return p } }
  const store = new Db(openDb(':memory:'))
  const ws = store.create('proj')
  const other = store.create('other')
  const nodes: WsNode[] = [
    { id: 'wd1', kind: 'terminal', x: 0, y: 0 },
    { id: 'wd2', kind: 'terminal', x: 0, y: 0, panes: { dir: 'h', ratio: 0.5, a: { id: 'wd2:p1' }, b: { id: 'wd2:p2' } } },
  ]
  store.save({ ...ws, nodes })
  store.save({ ...other, nodes: [{ id: 'wd3', kind: 'terminal', x: 0, y: 0 }] })
  for (const id of ['wd1', 'wd2:p1', 'wd2:p2', 'wd3']) sessions.open({ t: 'open', id, cols: 80, rows: 24 }, () => {})
  expect(sessions.isLive('wd1')).toBe(true)

  const r = await workspacesRoute(store, `/api/workspaces/${ws.id}`, 'DELETE', () => Promise.resolve(''), () => '/nonexistent-bg-dir')
  expect(r?.status).toBe(204)
  for (const id of ['wd1', 'wd2:p1', 'wd2:p2']) {
    expect(sessions.isLive(id)).toBe(false)
    expect(sessions.statusOf(id)).toBe(undefined)
  }
  expect(sessions.isLive('wd3')).toBe(true)
  expect(ptys.filter((p) => p.killed > 0).length).toBe(3)
  sessions.close('wd3')
})
