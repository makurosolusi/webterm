import { describe, expect, it } from 'vitest'
import { deliverNotes, formatDiffNotes, sendRefusal, SUBMIT_GAP_MS } from './DiffNode.notes'

describe('diff review notes', () => {
  it('formats a batch as one message in the Orca note format, quote-safe', () => {
    const text = formatDiffNotes([
      { id: '1', path: 'src/a.ts', line: 12, body: 'rename "x"\nplease' },
      { id: '2', path: 'b.md', line: 0, body: 'whole file' },
    ])
    expect(text).toBe([
      '[webterm] Review notes on your working-tree diff (2):',
      'File: src/a.ts\nLine: 12\nUser comment: "rename \\"x\\"\\nplease"',
      'File: b.md\nScope: file\nUser comment: "whole file"',
    ].join('\n\n'))
  })

  it('refuses without an agent, without notes, or while the agent is busy', () => {
    expect(sendRefusal(null, undefined, 1)).toMatch(/Wire an agent/)
    expect(sendRefusal('a', undefined, 0)).toMatch(/Add a note/)
    expect(sendRefusal('a', 'working', 1)).toMatch(/working/)
    expect(sendRefusal('a', 'blocked', 1)).toMatch(/permission/)
    expect(sendRefusal('a', 'waiting', 1)).toBeNull()
    expect(sendRefusal('a', undefined, 1)).toBeNull()
  })

  it('pastes the batch, then submits with a separate Enter after the gap', async () => {
    const writes: string[] = []
    const slept: number[] = []
    await deliverNotes((d) => writes.push(d), 'a\nb', async (ms) => { slept.push(ms) })
    expect(writes).toEqual(['\x1b[200~a\nb\x1b[201~', '\r'])
    expect(slept).toEqual([SUBMIT_GAP_MS])
  })
})
