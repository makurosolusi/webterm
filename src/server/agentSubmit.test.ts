// Confirmed submit contract with a fake session and a fake screen (as in outbox.test.ts): Claude gets
// its Enter only once the text is on screen, as a separate write, and must visibly start.
import { describe, expect, it } from 'vitest'
import type { AgentStatus } from '../shared/workspace'
import { KILL_LINE, SUBMIT_ENTERS, submitToNode } from './agentSubmit'

const RULE = '─'.repeat(40)
/** A Claude Code bottom box; `draft` undefined = dim placeholder (empty composer). */
const box = (draft?: string): string =>
  ['', RULE, draft === undefined ? '❯ \x1b[2mTry "fix typecheck errors"\x1b[22m' : `❯ ${draft}`, RULE, '  ? for shortcuts'].join('\n')
const DIALOG = ['Do you trust the files in this folder?', '', 'Enter to confirm · Esc to cancel'].join('\n')

/** Fake Claude PTY. `shows` = the typed text appears on screen; `swallow` = Enters ignored before one submits. */
function rig(o: { agent?: string; shows?: boolean; swallow?: number; screen?: () => string | null } = {}) {
  const st = { draft: undefined as string | undefined, status: undefined as AgentStatus | undefined, swallow: o.swallow ?? 0 }
  const writes: string[] = []
  const sessions = {
    agentIdOf: () => ('agent' in o ? o.agent : 'claude'),
    statusOf: () => st.status,
    screenSource: () => ({ data: '', cols: 80, rows: 24 }),
    input: (_id: string, d: string) => {
      writes.push(d)
      if (d === KILL_LINE) st.draft = undefined
      else if (d === '\r') { if (st.swallow > 0) st.swallow -= 1; else st.draft = undefined }
      else st.draft = (st.draft ?? '') + d
    },
  }
  const opts = {
    render: async () => o.screen?.() ?? box(o.shows === false ? undefined : st.draft),
    sleep: async () => {},
  }
  return { st, writes, submit: (text: string, extra = {}) => submitToNode(sessions, 'n1', text, { ...opts, ...extra }) }
}

describe('submitToNode', () => {
  it('happy path: types, confirms the draft, then Enter as a separate write', async () => {
    const r = rig()
    const order: string[] = []
    const res = await r.submit('analyse trending', { beforeEnter: () => order.push(`before:${r.writes.length}`) })
    expect(res).toEqual({ ok: true, started: true })
    expect(r.writes).toEqual(['analyse trending', '\r'])
    expect(order).toEqual(['before:1'])
  })

  it('multiline text goes as one bracketed paste', async () => {
    const r = rig()
    expect((await r.submit('a\nb')).ok).toBe(true)
    expect(r.writes).toEqual(['\x1b[200~a\nb\x1b[201~', '\r'])
  })

  it('text never appears on screen: Enter withheld, input box cleared, not_on_screen', async () => {
    const r = rig({ shows: false })
    const res = await r.submit('lost')
    expect(res).toMatchObject({ ok: false, reason: 'not_on_screen', cleared: true, message: expect.stringContaining('Enter withheld') })
    expect(r.writes).toEqual(['lost', KILL_LINE])
  })

  it('a swallowed Enter is retried once and the second one starts the agent', async () => {
    const r = rig({ swallow: 1 })
    expect(await r.submit('go')).toEqual({ ok: true, started: true })
    expect(r.writes).toEqual(['go', '\r', '\r'])
  })

  it('status working also counts as started', async () => {
    const r = rig({ swallow: 99 })
    const res = submitToNode({ agentIdOf: () => 'claude', statusOf: () => (r.writes.includes('\r') ? 'working' : undefined), screenSource: () => ({ data: '', cols: 80, rows: 24 }), input: (_i, d) => { r.writes.push(d) } },
      'n1', 'go', { render: async () => box(r.writes.length ? 'go' : undefined), sleep: async () => {} })
    expect(await res).toEqual({ ok: true, started: true })
    expect(r.writes).toEqual(['go', '\r'])
  })

  it('never starts: not_started after the bounded Enters', async () => {
    const r = rig({ swallow: 99 })
    const res = await r.submit('stuck')
    expect(res).toMatchObject({ ok: false, reason: 'not_started' })
    expect(r.writes).toEqual(['stuck', ...Array(SUBMIT_ENTERS).fill('\r')])
  })

  it('a dialog (or a still-booting Claude) is not_ready and nothing is typed', async () => {
    const r = rig({ screen: () => DIALOG })
    expect(await r.submit('x', { readyMs: 500 })).toMatchObject({ ok: false, reason: 'not_ready' })
    expect(r.writes).toEqual([])
  })

  it('waits for the composer to appear (spawn), then submits', async () => {
    let reads = 0
    const r = rig({ screen: () => (++reads < 5 ? '' : null) })
    expect(await r.submit('task', { readyMs: 1_000 })).toEqual({ ok: true, started: true })
    expect(r.writes).toEqual(['task', '\r'])
  })

  it('a plain shell gets the text and Enter in one write', async () => {
    const r = rig({ agent: undefined })
    expect(await r.submit('npm test')).toEqual({ ok: true, started: true })
    expect(r.writes).toEqual(['npm test\r'])
  })

  it('a non-Claude agent gets Enter after the fixed gap, as a separate write', async () => {
    const r = rig({ agent: 'codex' })
    expect(await r.submit('hi')).toEqual({ ok: true, started: true })
    expect(r.writes).toEqual(['hi', '\r'])
  })
})
