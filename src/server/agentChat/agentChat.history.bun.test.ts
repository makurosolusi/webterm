import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk'
import { AGENT_CHAT_TOOL_RESULT_MAX } from '../../shared/agentChat.wire'
import {
  AGENT_CHAT_HISTORY_DEFAULT_LIMIT, AGENT_CHAT_HISTORY_MAX_LIMIT, AGENT_CHAT_RESTART_NOTICE, cutMidTurn, historyItems, historyPage, loadTranscript, toolResultText,
} from './agentChat.history'

let n = 0
const sm = (type: SessionMessage['type'], message: unknown): SessionMessage =>
  ({ type, uuid: `u${++n}`, session_id: 's-1', message, parent_tool_use_id: null, parent_agent_id: null })
const user = (content: unknown) => sm('user', { role: 'user', content })
const asst = (id: string, ...content: unknown[]) => sm('assistant', { id, role: 'assistant', content })
const toolResult = (id: string, content: unknown, isError = false) => user([{ type: 'tool_result', tool_use_id: id, content, is_error: isError }])
const done = (): SessionMessage[] => [
  user('list files'),
  asst('m1', { type: 'text', text: 'Looking.' }),
  asst('m1', { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } }),
  toolResult('tu1', 'a.txt'),
  asst('m2', { type: 'text', text: 'One file.' }),
]

describe('agent chat history', () => {
  test('maps the transcript to one message / tool item each, in first-seen order', () => {
    expect(historyItems(done())).toMatchObject([
      { t: 'message', role: 'user', parts: [{ k: 'text', text: 'list files' }] },
      { t: 'message', messageId: 'm1', role: 'assistant', parts: [{ k: 'text', text: 'Looking.' }, { k: 'tool', id: 'tu1' }] },
      { t: 'tool', id: 'tu1', name: 'Bash', input: { command: 'ls' }, state: 'done', result: 'a.txt' },
      { t: 'message', messageId: 'm2', parts: [{ k: 'text', text: 'One file.' }] },
    ])
    expect(historyItems(done()).some((e) => e.t === 'status')).toBe(false)
  })

  test('a long tool result is truncated in the page and complete through toolResultText', () => {
    const big = 'x'.repeat(AGENT_CHAT_TOOL_RESULT_MAX + 10)
    const msgs = [user('go'), asst('m1', { type: 'tool_use', id: 'tu1', name: 'Read', input: {} }), toolResult('tu1', [{ type: 'text', text: big }]), asst('m2', { type: 'text', text: 'ok' })]
    const tool = historyItems(msgs).find((e) => e.t === 'tool')
    expect(tool).toMatchObject({ truncated: true })
    expect(tool?.t === 'tool' && tool.result?.length).toBe(AGENT_CHAT_TOOL_RESULT_MAX)
    expect(toolResultText(msgs, 'tu1')).toBe(big)
    expect(toolResultText(msgs, 'nope')).toBe(undefined)
  })

  test('pages newest first with a cursor, limit clamped to the named max', () => {
    const msgs = Array.from({ length: 30 }, (_, i) => [user(`q${i}`), asst(`m${i}`, { type: 'text', text: `a${i}` })]).flat()
    const first = historyPage(msgs, { limit: 10, busy: false })
    expect(first.items).toHaveLength(10)
    expect(first.items.at(-1)).toMatchObject({ messageId: 'm29', cursor: 59 })
    expect(first.next).toBe(50)
    const older = historyPage(msgs, { before: first.next ?? 0, limit: 10, busy: false })
    expect(older.items.map((e) => e.cursor)).toEqual(Array.from({ length: 10 }, (_, i) => 40 + i))
    expect(historyPage(msgs, { before: 5, limit: 10, busy: false })).toMatchObject({ next: null })
    expect(historyPage(msgs, { busy: false }).items).toHaveLength(AGENT_CHAT_HISTORY_DEFAULT_LIMIT)
    expect(historyPage(msgs, { limit: 10_000, busy: false }).items).toHaveLength(Math.min(60, AGENT_CHAT_HISTORY_MAX_LIMIT))
    expect(historyPage([], { busy: false })).toEqual({ items: [], next: null })
  })

  test('a turn cut by a restart ends with the notice; a finished or user-interrupted turn does not', () => {
    const cutAtTool = [user('go'), asst('m1', { type: 'tool_use', id: 'tu1', name: 'Bash', input: {} })]
    const cutAfterResult = [...cutAtTool, toolResult('tu1', 'ok')]
    const cutAtPrompt = [user('go')]
    for (const msgs of [cutAtTool, cutAfterResult, cutAtPrompt]) {
      expect(cutMidTurn(msgs)).toBe(true)
      expect(historyPage(msgs, { busy: false }).items.at(-1)).toMatchObject({ t: 'notice', level: 'warn', text: AGENT_CHAT_RESTART_NOTICE })
    }
    expect(cutMidTurn(done())).toBe(false)
    expect(cutMidTurn([...cutAtTool, user([{ type: 'text', text: '[Request interrupted by user]' }])])).toBe(false)
    expect(historyPage(cutAtTool, { busy: true }).items.some((e) => e.t === 'notice')).toBe(false)
    expect(historyPage(cutAtTool, { before: 1, busy: false }).items.some((e) => e.t === 'notice')).toBe(false)
  })

  describe('real transcript through the SDK (tmp CLAUDE_CONFIG_DIR)', () => {
    const prevConfig = process.env.CLAUDE_CONFIG_DIR
    const dir = mkdtempSync('/tmp/st-chat-cfg-')
    afterAll(() => {
      if (prevConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = prevConfig
      rmSync(dir, { recursive: true, force: true })
    })

    test('getSessionMessages reads the JSONL and the mapper renders it', async () => {
      process.env.CLAUDE_CONFIG_DIR = dir
      const sid = '0b7c2c1e-1d2f-4c3a-9e8b-7a6f5e4d3c2b'
      const proj = join(dir, 'projects', '-tmp-chat')
      mkdirSync(proj, { recursive: true })
      const base = { sessionId: sid, cwd: '/tmp/chat', isSidechain: false, userType: 'external', version: '2.1.300', timestamp: new Date(0).toISOString() }
      const lines = [
        { ...base, type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'hello' } },
        { ...base, type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } }] } },
      ]
      writeFileSync(join(proj, `${sid}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
      const msgs = await loadTranscript(sid)
      expect(historyPage(msgs, { busy: false }).items).toMatchObject([
        { t: 'message', role: 'user', parts: [{ text: 'hello' }] },
        { t: 'message', messageId: 'm1', parts: [{ k: 'tool', id: 'tu1' }] },
        { t: 'tool', id: 'tu1', state: 'running' },
        { t: 'notice', text: AGENT_CHAT_RESTART_NOTICE },
      ])
      expect(await loadTranscript('00000000-0000-4000-8000-000000000000')).toEqual([])
    })
  })
})
