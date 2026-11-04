// Bun-only (bun:sqlite). Guards the harness primitives the golden tests lean on.
import { expect, test } from 'bun:test'
import { execWrite } from '../../ledger/ledgerCore'
import { createHarness, GOLDEN_CONVERSATION, GOLDEN_PROJECT } from './goldenHarness'

test('tablesWith finds a value in any table and misses an absent one', async () => {
  const h = await createHarness({ turns: [] })
  try {
    expect(h.tablesWith('needle-xyz')).toEqual([])
    execWrite(h.db, `UPDATE project SET name = ? WHERE id = ?`, 'has needle-xyz inside', GOLDEN_PROJECT)
    expect(h.tablesWith('needle-xyz')).toEqual(['project'])
  } finally {
    await h.cleanup()
  }
})

test('restart reopens the same file: data survives and the turn counter starts over', async () => {
  const h = await createHarness({ turns: [[{ text: 'hi' }]] })
  try {
    await h.service.submit({ conversationId: GOLDEN_CONVERSATION, clientMessageId: 'r1', text: 'hi' }).done
    expect(h.calls).toBe(1)
    h.restart([])
    expect(h.count(`SELECT COUNT(*) AS c FROM project WHERE id = ?`, GOLDEN_PROJECT)).toBe(1)
    expect(h.count(`SELECT COUNT(*) AS c FROM central_turn`)).toBe(1)
    expect(h.calls).toBe(0)
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('a scripted MCP call reaches the real registry and its receipt lands in the chat', async () => {
  const h = await createHarness({ turns: [[{ call: 'nope_tool', args: {} }, { text: 'done' }]] })
  try {
    const turn = await h.service.submit({ conversationId: GOLDEN_CONVERSATION, clientMessageId: 'r2', text: 'go' }).done
    expect(turn.status).toBe('succeeded')
    expect(h.receipts().map((r) => [r.name, r.ok, r.errorCode])).toEqual([['nope_tool', false, 'unknown_tool']])
  } finally {
    await h.cleanup()
  }
}, 30_000)
