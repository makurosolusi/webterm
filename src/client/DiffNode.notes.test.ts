import { describe, expect, it } from 'vitest'
import { enqueueNotes, formatDiffNotes, notesOperationId, sendRefusal } from './DiffNode.notes'

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

  it('refuses only without an agent or without notes (a busy agent queues instead)', () => {
    expect(sendRefusal(null, 1)).toMatch(/Wire an agent/)
    expect(sendRefusal('a', 0)).toMatch(/Add a note/)
    expect(sendRefusal('a', 1)).toBeNull()
  })

  it('enqueues the batch in the server outbox with a retry-stable operationId', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return new Response(JSON.stringify({ message: { id: 'm1', status: 'queued' }, deduped: calls.length > 1 }), { status: calls.length > 1 ? 200 : 202 })
    }) as unknown as typeof fetch
    const batch = [{ id: 'n1', path: 'a.ts', line: 3, body: 'x' }]
    expect(await enqueueNotes('agent1', batch, fake)).toMatchObject({ deduped: false })
    expect(await enqueueNotes('agent1', batch, fake)).toMatchObject({ deduped: true }) // retry
    expect(calls[0].url).toMatch(/^\/api\/outbox/)
    const sent = JSON.parse(String(calls[0].init.body))
    expect(sent).toEqual({ to: 'agent1', body: formatDiffNotes(batch), operationId: notesOperationId('agent1', batch) })
    expect(JSON.parse(String(calls[1].init.body)).operationId).toBe(sent.operationId)
  })

  it('names the operation and the server reason when the outbox refuses', async () => {
    const fake = (async () => new Response(JSON.stringify({ error: 'bad_target', message: 'node not found' }), { status: 404 })) as unknown as typeof fetch
    await expect(enqueueNotes('gone', [{ id: 'n', path: 'a', line: 0, body: 'b' }], fake)).rejects.toThrow('Send review notes to gone: node not found')
  })
})
