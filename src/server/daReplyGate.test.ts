import { describe, expect, it } from 'vitest'
import { DA_REPLY_TTL_OTHER_MS, DA_REPLY_TTL_TMUX_MS, DaReplyGate } from './daReplyGate'

const ESC = '\x1b'
const PRIMARY_REPLY = `${ESC}[?1;2c`
const SECONDARY_REPLY = `${ESC}[>0;276;0c`

describe('DaReplyGate', () => {
  it('exposes TTLs ordered tmux < other', () => {
    expect(DA_REPLY_TTL_TMUX_MS).toBeLessThan(DA_REPLY_TTL_OTHER_MS)
  })

  it('passes ordinary input through, even with no query seen', () => {
    const gate = new DaReplyGate(1000)
    expect(gate.filterInput('ls -la\r', 0)).toBe('ls -la\r')
    expect(gate.filterInput(`${ESC}[1;2R`, 0)).toBe(`${ESC}[1;2R`)
    expect(gate.filterInput('', 0)).toBe('')
  })

  it('drops a reply that nobody asked for', () => {
    const gate = new DaReplyGate(1000)
    expect(gate.filterInput(PRIMARY_REPLY, 0)).toBe('')
  })

  it('lets exactly one viewer answer a query', () => {
    const gate = new DaReplyGate(1000)
    gate.noteOutput(`hello ${ESC}[c`, 0)
    expect(gate.filterInput(PRIMARY_REPLY, 10)).toBe(PRIMARY_REPLY)
    expect(gate.filterInput(PRIMARY_REPLY, 11)).toBe('')
  })

  it('keeps primary and secondary credits separate', () => {
    const gate = new DaReplyGate(1000)
    gate.noteOutput(`${ESC}[>c`, 0)
    expect(gate.filterInput(PRIMARY_REPLY, 1)).toBe('')
    expect(gate.filterInput(SECONDARY_REPLY, 2)).toBe(SECONDARY_REPLY)
  })

  it('recognises the explicit-zero query forms', () => {
    const gate = new DaReplyGate(1000)
    gate.noteOutput(`${ESC}[0c${ESC}[>0c`, 0)
    expect(gate.filterInput(PRIMARY_REPLY + SECONDARY_REPLY, 1)).toBe(PRIMARY_REPLY + SECONDARY_REPLY)
  })

  it('filters a combined write reply by reply', () => {
    const gate = new DaReplyGate(1000)
    gate.noteOutput(`${ESC}[c`, 0)
    expect(gate.filterInput(PRIMARY_REPLY + SECONDARY_REPLY, 1)).toBe(PRIMARY_REPLY)
  })

  it('does not touch a write that mixes a reply with other bytes', () => {
    const gate = new DaReplyGate(1000)
    const mixed = `${PRIMARY_REPLY}x`
    expect(gate.filterInput(mixed, 0)).toBe(mixed)
    const pasted = `${ESC}[?1c rest`
    expect(gate.filterInput(pasted, 0)).toBe(pasted)
  })

  it('expires credits after the TTL', () => {
    const gate = new DaReplyGate(1000)
    gate.noteOutput(`${ESC}[c`, 0)
    expect(gate.filterInput(PRIMARY_REPLY, 1001)).toBe('')
    gate.noteOutput(`${ESC}[c`, 5000)
    expect(gate.filterInput(PRIMARY_REPLY, 6000)).toBe(PRIMARY_REPLY)
  })

  it('skips an expired credit and spends a live one behind it', () => {
    const gate = new DaReplyGate(1000)
    gate.noteOutput(`${ESC}[c`, 0)
    gate.noteOutput(`${ESC}[c`, 900)
    expect(gate.filterInput(PRIMARY_REPLY, 1500)).toBe(PRIMARY_REPLY)
    expect(gate.filterInput(PRIMARY_REPLY, 1501)).toBe('')
  })

  it('finds a query split across chunks, at every split point', () => {
    for (const q of [`${ESC}[c`, `${ESC}[0c`, `${ESC}[>c`, `${ESC}[>0c`]) {
      for (let cut = 1; cut < q.length; cut++) {
        const gate = new DaReplyGate(1000)
        gate.noteOutput(`out${q.slice(0, cut)}`, 0)
        gate.noteOutput(q.slice(cut), 1)
        const reply = q.includes('>') ? SECONDARY_REPLY : PRIMARY_REPLY
        expect(gate.filterInput(reply, 2), JSON.stringify([q, cut])).toBe(reply)
      }
    }
  })

  it('does not invent a query from an unrelated split escape', () => {
    const gate = new DaReplyGate(1000)
    gate.noteOutput(`${ESC}[3`, 0)
    gate.noteOutput('c', 1)
    expect(gate.filterInput(PRIMARY_REPLY, 2)).toBe('')
  })

  it('caps remembered queries per kind', () => {
    const gate = new DaReplyGate(1_000_000)
    for (let i = 0; i < 100; i++) gate.noteOutput(`${ESC}[c`, i)
    let granted = 0
    while (gate.filterInput(PRIMARY_REPLY, 200) !== '') granted++
    expect(granted).toBe(32)
  })
})
