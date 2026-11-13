// A status REMOVAL (terminal closed, or restarted by a fresh open) reaches every UI socket through
// the `broadcast` hook, not only the caller and the PTY's subscribers: the Sessions panel of another
// tab lists that node too and would keep showing its old status. Fake PTY, no real shell or Claude.
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerMsg } from '../shared/protocol'

const DIR = mkdtempSync(join(tmpdir(), 'webterm-statusremoval-'))
const saved = { data: process.env.WEBTERM_DATA_DIR, home: process.env.HOME, claude: process.env.CLAUDE_CONFIG_DIR }
process.env.WEBTERM_DATA_DIR = DIR
process.env.HOME = DIR
process.env.CLAUDE_CONFIG_DIR = join(DIR, '.claude')
afterAll(() => {
  process.env.WEBTERM_DATA_DIR = saved.data
  process.env.HOME = saved.home
  process.env.CLAUDE_CONFIG_DIR = saved.claude
  rmSync(DIR, { recursive: true, force: true })
})

// Imported after the env above: a static import would run first and could read the real dirs.
const { Sessions } = await import('./sessions')
const { FakePty } = await import('./fakePty.testutil')

const shell = (id: string) => ({ t: 'open' as const, id, cols: 80, rows: 24 })
const statuses = (frames: ServerMsg[]) => frames.filter((m) => m.t === 'status')

function wired() {
  const s = new Sessions({ spawn: () => new FakePty(4242), now: () => 1_700_000_000_000 })
  const everyone: ServerMsg[] = []
  s.broadcast = (m) => everyone.push(m)
  return { s, everyone }
}

describe('status removal is broadcast', () => {
  test('a fresh open (restart) broadcasts "no status" to every UI socket', () => {
    const { s, everyone } = wired()
    s.setStatus('t1', 'working')
    s.open(shell('t1'), () => {})
    expect(statuses(everyone).at(-1)).toEqual({ t: 'status', id: 't1' })
    expect(s.statusOf('t1')).toBe(undefined)
  })

  test('close broadcasts the removal once and does not send it to the caller a second time', () => {
    const { s, everyone } = wired()
    const caller: ServerMsg[] = []
    s.open(shell('t2'), (m) => caller.push(m))
    s.setStatus('t2', 'working')
    everyone.length = 0
    caller.length = 0
    s.close('t2', (m) => caller.push(m))
    expect(statuses(everyone)).toEqual([{ t: 'status', id: 't2' }])
    expect(statuses(caller)).toEqual([])
  })

  test('close of a node with no live PTY (restart case) still broadcasts the removal', () => {
    const { s, everyone } = wired()
    s.setStatus('gone', 'blocked')
    everyone.length = 0
    const caller: ServerMsg[] = []
    s.close('gone', (m) => caller.push(m))
    expect(statuses(everyone)).toEqual([{ t: 'status', id: 'gone' }])
    expect(caller.filter((m) => m.t === 'exit')).toHaveLength(1)
  })

  test('unwired (no broadcast): the caller still hears the removal, as before', () => {
    const s = new Sessions({ spawn: () => new FakePty(1), now: () => 1 })
    s.setStatus('solo', 'working')
    const caller: ServerMsg[] = []
    s.close('solo', (m) => caller.push(m))
    expect(statuses(caller)).toEqual([{ t: 'status', id: 'solo' }])
  })
})
