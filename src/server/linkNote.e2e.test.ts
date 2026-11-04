// End to end without mocks of the gate itself: real `Sessions` (fake PTY), real server-side screen
// rebuild (`@xterm/xterm`) of a REAL Claude Code capture, real composer reader. Only the PTY and the
// workspace list are fakes.
import { describe, expect, it } from 'vitest'
import type { Workspace } from '../shared/workspace'
import capture from './__fixtures__/claude-composer-capture.json'
import { FakePty } from './fakePty.testutil'
import { LinkNoteDelivery } from './linkNoteDelivery'
import { Sessions } from './sessions'

const S = capture.screens as Record<string, string>
const PLACEHOLDER = '\x1b[2mTry "fix typecheck errors"\x1b[0m'
const rows = S.empty.replace(/\n$/, '').split('\n').length
/** Claude Code repainting its whole screen, with `composer` in the input box (null = placeholder). */
const paint = (composer: string | null): string =>
  '\x1b[H\x1b[2J' + S.empty.replace(/\n$/, '').replace(PLACEHOLDER, composer ?? PLACEHOLDER).replace(/\n/g, '\r\n')

describe('link note, end to end on a real Claude Code screen', () => {
  it('idle + empty → note typed, seen on screen, then submitted; a draft blocks it', async () => {
    const pty = new FakePty(4242)
    const sessions = new Sessions({ spawn: () => pty })
    sessions.open({ t: 'open', id: 'claude1', cols: 120, rows, cwd: '/tmp' } as never, () => {})
    let typed = ''
    const origWrite = pty.write.bind(pty)
    pty.write = (d: string) => { origWrite(d); if (d !== '\r') { typed += d; pty.emitData(paint(typed)) } }
    const ws = {
      nodes: [{ id: 'claude1', kind: 'agent', agentId: 'claude', title: 'Claude' }, { id: 'web1', kind: 'browser', title: 'makuro-browser' }],
      bridges: [],
    } as unknown as Workspace
    const d = new LinkNoteDelivery({ workspaces: () => [ws], sessions, sleep: async () => {} })

    pty.emitData(paint('half typed'))
    await d.tick() // baseline
    ws.bridges.push({ id: 'b', source: 'web1', target: 'claude1', kind: 'context' })
    await d.tick()
    expect(pty.writes).toEqual([]) // the user's draft is on screen

    pty.emitData(paint(null)) // user cleared the input
    await d.tick()
    expect(pty.writes).toHaveLength(2)
    expect(pty.writes[0]).toMatch(/^\[webterm\] The user wired browser node "makuro-browser" \(id web1\) to you/)
    expect(pty.writes[1]).toBe('\r')
    sessions.close('claude1')
  })
})
