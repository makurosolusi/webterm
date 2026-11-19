import { describe, expect, it } from 'vitest'
import { addSub, dispatchTerminalFrame, resetTerminalsForTests } from './ws.terminals'

// Client half of the output path: every chunk of a large stream reaches xterm exactly once, also when a
// reconnect replays an overlapping gap or the server resets and replays the whole log (backpressure resync).
describe('terminal frame routing under a 2 MB stream', () => {
  const CHUNK = 'x'.repeat(1024)
  const chunks = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => ({ seq: from + i, data: CHUNK }))

  it('draws each chunk once across an overlapping replay and a reset', () => {
    resetTerminalsForTests()
    let drawn = 0
    addSub('n', (d) => { drawn += d.length }, () => {}, () => { drawn = 0 })
    dispatchTerminalFrame({ t: 'reset', id: 'n', epoch: 'e1' })
    for (const c of chunks(1, 1000)) dispatchTerminalFrame({ t: 'output', id: 'n', ...c })
    for (const c of chunks(900, 2000)) dispatchTerminalFrame({ t: 'output', id: 'n', ...c }) // overlapping replay
    expect(drawn).toBe(2000 * 1024)
    dispatchTerminalFrame({ t: 'reset', id: 'n', epoch: 'e1' }) // server resync after dropped output
    for (const c of chunks(1, 2000)) dispatchTerminalFrame({ t: 'output', id: 'n', ...c })
    expect(drawn).toBe(2000 * 1024)
  })
})
