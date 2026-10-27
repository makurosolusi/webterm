// Bun-only (needs Bun.Terminal via spawnPty); runs under `bun test`, excluded
// from vitest. Ambient types for 'bun:test' live in ./bun-test.d.ts.
import { test, expect } from 'bun:test'
import type { ServerMsg } from '../shared/protocol'
import { Sessions } from './sessions'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function collector() {
  const chunks: string[] = []
  const send = (m: ServerMsg) => { if (m.t === 'output') chunks.push(m.data) }
  return { send, joined: () => chunks.join('') }
}

async function pollFor(get: () => string, needle: string, maxMs = 3000) {
  const deadline = Date.now() + maxMs
  while (Date.now() < deadline) {
    if (get().includes(needle)) return
    await sleep(50)
  }
}

test('pty survives detach and replays scrollback on re-attach', async () => {
  const s = new Sessions()
  const a = collector()
  s.open({ t: 'open', id: 't1', cols: 80, rows: 24 }, a.send)

  s.input('t1', 'echo HELLO_WEBTERM\n')
  await pollFor(a.joined, 'HELLO_WEBTERM')
  expect(a.joined()).toContain('HELLO_WEBTERM')

  // Re-attach a fresh subscriber: scrollback replays immediately (refresh survival).
  const b = collector()
  s.open({ t: 'open', id: 't1', cols: 80, rows: 24 }, b.send)
  expect(b.joined()).toContain('HELLO_WEBTERM')

  // Detach must NOT kill the pty: it still accepts input and keeps buffering.
  s.detach(b.send)
  s.input('t1', 'echo STILL_ALIVE\n')
  const c = collector()
  await pollFor(() => { s.open({ t: 'open', id: 't1', cols: 80, rows: 24 }, c.send); return c.joined() }, 'STILL_ALIVE')
  expect(c.joined()).toContain('STILL_ALIVE')

  // close() kills the pty and drops the session. Re-opening the same id now
  // spawns a FRESH shell with an empty buffer, so the replay carries none of
  // the old scrollback — proof the previous session is truly gone.
  s.close('t1')
  const d = collector()
  s.open({ t: 'open', id: 't1', cols: 80, rows: 24 }, d.send)
  expect(d.joined()).toBe('')
  s.close('t1')
})

test('open with a cmd launches it through the login shell', async () => {
  const s = new Sessions()
  const a = collector()
  s.open({ t: 'open', id: 'c1', cols: 80, rows: 24, cmd: 'echo hi' }, a.send)
  await pollFor(a.joined, 'hi')
  expect(a.joined()).toContain('hi')
  s.close('c1')
})
