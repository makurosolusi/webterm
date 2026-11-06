// Truthful agent end states (agent-211-A2, A5): a failed agent is never "Done", a stopped one says
// so, and an agent whose program is missing fails its open with the preflight's words.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerMsg } from '../shared/protocol'
import { Sessions } from './sessions'
import { FakePty } from './fakePty.testutil'
import { PROBE_TEXT } from './claudeLauncher/claudeLaunch.probe'

function fakeSessions() {
  const ptys: FakePty[] = []
  const sessions = new Sessions({ spawn: () => { const p = new FakePty(1000 + ptys.length); ptys.push(p); return p }, now: () => 1_700_000_000_000 })
  return { sessions, ptys }
}
const agent = (id: string) => ({ t: 'open' as const, id, cols: 80, rows: 24, agentId: 'claude' as const })
const noop = (): void => {}

describe('agent exit status (A2)', () => {
  test('an agent that exits 1 or 127 is failed, never done', () => {
    for (const code of [1, 127]) {
      const { sessions, ptys } = fakeSessions()
      sessions.open(agent('x1'), noop)
      ptys[0].emitExit(code)
      expect(sessions.statusOf('x1')).toBe('failed')
    }
  })

  test('an agent that exits 0 is done, and a plain shell is done whatever its code', () => {
    const { sessions, ptys } = fakeSessions()
    sessions.open(agent('x2'), noop)
    sessions.open({ t: 'open', id: 'sh', cols: 80, rows: 24 }, noop)
    ptys[0].emitExit(0)
    ptys[1].emitExit(1)
    expect(sessions.statusOf('x2')).toBe('done')
    expect(sessions.statusOf('sh')).toBe('done')
  })
})

describe('stop (A5)', () => {
  test('closing a live agent leaves it stopped for every viewer; closing a finished one does not', () => {
    const { sessions, ptys } = fakeSessions()
    const seen: ServerMsg[] = []
    sessions.open(agent('st'), (m) => { seen.push(m) })
    sessions.setStatus('st', 'working')
    sessions.close('st')
    expect(sessions.statusOf('st')).toBe('stopped')
    expect(seen.filter((m) => m.t === 'status').at(-1)).toEqual({ t: 'status', id: 'st', status: 'stopped' })
    expect(seen.filter((m) => m.t === 'exit')).toEqual([{ t: 'exit', id: 'st', code: -1, reason: 'closed' }])

    sessions.open(agent('dn'), noop)
    ptys[1].emitExit(0)
    sessions.close('dn')
    expect(sessions.statusOf('dn')).toBe(undefined)
  })
})

describe('missing agent program (A2)', () => {
  const saved = { PATH: process.env.PATH, SHELL: process.env.SHELL, HOME: process.env.HOME, WEBTERM_DATA_DIR: process.env.WEBTERM_DATA_DIR, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR }
  let dir = ''
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'webterm-missing-'))
    // A login shell that resolves no PATH, so the probe cannot find a real claude elsewhere.
    const shell = join(dir, 'noshell')
    writeFileSync(shell, '#!/bin/sh\nexit 1\n')
    chmodSync(shell, 0o755)
    Object.assign(process.env, { PATH: join(dir, 'empty-bin'), SHELL: shell, HOME: dir, WEBTERM_DATA_DIR: dir, CLAUDE_CONFIG_DIR: dir })
  })
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    rmSync(dir, { recursive: true, force: true })
  })

  test('a canvas open of claude with no claude on PATH shows the probe message and one failed exit', () => {
    const sessions = new Sessions({ shell: '/bin/sh' })
    const seen: ServerMsg[] = []
    sessions.handle({ ...agent('mb'), cmd: 'claude' }, (m) => { seen.push(m) }) // the client sends the stock command
    const text = seen.flatMap((m) => (m.t === 'output' ? [m.data] : [])).join('')
    expect(text).toContain(PROBE_TEXT.claudeMissing)
    expect(seen.filter((m) => m.t === 'exit')).toEqual([{ t: 'exit', id: 'mb', code: -1, reason: 'failed' }])
    expect(sessions.statusOf('mb')).toBe('failed')
    expect(sessions.isLive('mb')).toBe(false)
  })

  test('a launch line led by a shell builtin is not probed: it spawns', () => {
    const sessions = new Sessions({ shell: '/bin/sh' })
    const seen: ServerMsg[] = []
    sessions.handle({ ...agent('bi'), cmd: 'exit 0' }, (m) => { seen.push(m) })
    expect(seen.filter((m) => m.t === 'exit')).toEqual([])
    expect(sessions.isLive('bi')).toBe(true)
    sessions.close('bi')
  })
})
