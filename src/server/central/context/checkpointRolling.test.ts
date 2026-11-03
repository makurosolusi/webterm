import { describe, expect, it } from 'vitest'
import { CHECKPOINT_NARRATIVE_MAX } from '../../ledger/ledgerSchemaV8'
import { rollingSummarize } from './checkpointRolling'

const signal = new AbortController().signal
const msg = (role: 'user' | 'assistant', text: string) => ({ role, text }) as never

describe('rollingSummarize', () => {
  it('appends the newest message heads after the previous narrative', async () => {
    const out = await rollingSummarize({ previousNarrative: 'earlier', messages: [msg('user', 'hello\n  world'), msg('assistant', 'ok')] } as never, signal)
    expect(out).toEqual({ narrative: 'earlier\nuser: hello world\nassistant: ok', model: 'deterministic' })
  })
  it('keeps only the last 8 messages and clips each to 160 chars', async () => {
    const messages = Array.from({ length: 10 }, (_, i) => msg('user', `${i}${'x'.repeat(500)}`))
    const lines = (await rollingSummarize({ previousNarrative: null, messages } as never, signal)).narrative.split('\n')
    expect(lines).toHaveLength(8)
    expect(lines[0]?.startsWith('user: 2x')).toBe(true)
    expect(lines.every((l) => l.length <= 'user: '.length + 160)).toBe(true)
  })
  it('never exceeds the column cap and keeps the newest text', async () => {
    const out = await rollingSummarize({ previousNarrative: 'o'.repeat(CHECKPOINT_NARRATIVE_MAX), messages: [msg('user', 'NEWEST')] } as never, signal)
    expect(out.narrative.length).toBe(CHECKPOINT_NARRATIVE_MAX)
    expect(out.narrative.endsWith('user: NEWEST')).toBe(true)
  })
})
