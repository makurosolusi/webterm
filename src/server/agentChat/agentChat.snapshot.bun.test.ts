// chatSnapshot / chatTurns: what Central reads of an agent chat node, derived from the session's event log.
import { describe, expect, test } from 'bun:test'
import type { AgentChatEvent, AgentChatEventBody } from '../../shared/agentChat.wire'
import type { AgentChatSession } from './agentChat.session'
import { CHAT_PENDING_SUMMARY_MAX, chatSnapshot, chatTurns, nodeModeOf, pendingSummary } from './agentChat.snapshot'

/** A session stand-in: only the read side chatSnapshot uses. */
const fakeSession = (bodies: AgentChatEventBody[], o: { live?: boolean; status?: string } = {}): AgentChatSession => ({
  events: () => bodies.map((b, i) => ({ ...b, seq: i + 1 }) as AgentChatEvent),
  live: () => o.live ?? true,
  status: () => o.status ?? 'idle',
}) as unknown as AgentChatSession

const init = (model: string, mode = 'default'): AgentChatEventBody =>
  ({ t: 'init', sessionId: 's-1', model, mode, commands: [], capabilities: [], cliVersion: '2', cwd: '/w' })
const result = (costUsd: number): AgentChatEventBody => ({ t: 'result', costUsd, durationMs: 1, isError: false, interrupted: false, denials: 0 })
const ask = (requestId: string, input: unknown, title?: string): AgentChatEventBody =>
  ({ t: 'permission', requestId, kind: 'tool', toolName: 'Bash', toolUseId: `tu-${requestId}`, input, ...(title ? { title } : {}) })

describe('chatSnapshot', () => {
  test('no session: stored node only, not live, no status/cost/context/pending, thinking defaults on', () => {
    expect(chatSnapshot(undefined, { chatConfig: { model: 'opus', thinking: false }, permissionMode: 'plan' })).toEqual({
      live: false, status: null, model: 'opus', config: { model: 'opus', effort: null, thinking: false },
      permissionMode: 'plan', costUsd: null, contextPct: null, pending: null,
    })
    expect(chatSnapshot(undefined, {})).toMatchObject({ model: null, config: { model: null, effort: null, thinking: true }, permissionMode: null })
  })

  test('live session: init model and mode, later config/mode events, context percent, summed per-Query cost', () => {
    const s = fakeSession([
      { t: 'status', status: 'starting' },
      init('claude-sonnet', 'default'),
      { t: 'config', config: { model: 'sonnet', effort: 'high', thinking: true } },
      result(0.02), result(0.05), // cumulative per Query: 0.05 so far
      { t: 'status', status: 'starting' }, // a new Query: its cost starts over
      result(0.01),
      { t: 'mode', mode: 'acceptEdits' },
      { t: 'context', context: { used: 50_000, window: 200_000 } },
    ], { status: 'thinking' })
    const snap = chatSnapshot(s, { permissionMode: 'manual' })
    expect(snap).toMatchObject({ live: true, status: 'thinking', model: 'claude-sonnet', config: { model: 'sonnet', effort: 'high', thinking: true }, permissionMode: 'acceptEdits', contextPct: 25 })
    expect(Math.round((snap.costUsd ?? 0) * 1e6)).toBe(60_000) // 0.05 + 0.01, float-safe
  })

  test('init mode "default" is the node mode "manual"; a suspended session reports the configured model, not the old init one', () => {
    const s = fakeSession([init('claude-old'), { t: 'config', config: { model: 'haiku', thinking: true } }], { live: false })
    expect(chatSnapshot(s, { permissionMode: 'plan' })).toMatchObject({ live: false, model: 'haiku', permissionMode: 'manual' })
    expect(nodeModeOf('default')).toBe('manual')
    expect(nodeModeOf('bypassPermissions')).toBe('bypassPermissions')
    expect(nodeModeOf('nonsense')).toBe(undefined)
  })

  test('pending is the newest unresolved permission, summarized by title, else the telling input field, else JSON', () => {
    const s = fakeSession([
      ask('r1', { command: 'ls -la' }),
      ask('r2', { file_path: '/a.ts' }),
      { t: 'permissionResolved', requestId: 'r2', outcome: 'allow' },
    ])
    expect(chatSnapshot(s, {}).pending).toEqual({ tool: 'Bash', summary: 'ls -la' })
    expect(chatSnapshot(fakeSession([...[ask('r1', {})], { t: 'permissionResolved', requestId: 'r1', outcome: 'deny' }]), {}).pending).toBe(null)
    expect(pendingSummary(ask('r', { command: 'x' }, 'Run the tests') as never)).toBe('Run the tests')
    expect(pendingSummary(ask('r', { n: 1 }) as never)).toBe('{"n":1}')
    const long = pendingSummary(ask('r', { command: 'y'.repeat(500) }) as never)
    expect(long).toHaveLength(CHAT_PENDING_SUMMARY_MAX)
    expect(long.endsWith('…')).toBe(true)
  })
})

describe('chatTurns', () => {
  const msg = (messageId: string, role: 'user' | 'assistant', text: string, parentId?: string): AgentChatEventBody =>
    ({ t: 'message', messageId, role, parts: [{ k: 'text', text }], ...(parentId ? { parentId } : {}) }) as AgentChatEventBody

  test('transcript then live turns it lacks, a re-emitted live message replaces its copy, subagent and non-text skipped, newest last', () => {
    const transcript = [msg('u1', 'user', 'hi'), msg('a1', 'assistant', 'hello')]
    const live = [
      msg('a1', 'assistant', 'hello'), // already saved
      msg('u2', 'user', 'list files'),
      msg('a2', 'assistant', 'Let me'),
      msg('sub', 'assistant', 'inner', 'tu-1'),
      { t: 'message', messageId: 'a3', role: 'assistant', parts: [{ k: 'tool', id: 'tu-1' }] } as unknown as AgentChatEventBody,
      msg('a2', 'assistant', 'Let me look.'),
    ].map((b, i) => ({ ...b, seq: i + 1 }) as AgentChatEvent)
    expect(chatTurns(transcript, live, 10)).toEqual([
      { role: 'user', text: 'hi' }, { role: 'assistant', text: 'hello' }, { role: 'user', text: 'list files' }, { role: 'assistant', text: 'Let me look.' },
    ])
    expect(chatTurns(transcript, live, 1)).toEqual([{ role: 'assistant', text: 'Let me look.' }])
    expect(chatTurns(transcript, live, 0)).toEqual([])
  })
})
