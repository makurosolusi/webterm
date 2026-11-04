import { describe, expect, test } from 'vitest'
import { buildBrief, compactCount, renderBriefText, type BriefEvent, type BriefInput } from './brief.model'

const T0 = 1_700_000_000_000
const ev = (kind: string, nodeId: string | null, payload: unknown = null, workspaceId: string | null = null): BriefEvent => ({ ts: T0 + 1, kind, nodeId, workspaceId, payload })
const LABELS: Record<string, string> = { a: 'Claude in api', b: 'Build in web', c: 'Codex in api', t: 'Terminal in api' }

function input(events: BriefEvent[], extra: Partial<BriefInput> = {}): BriefInput {
  return {
    since: T0, now: T0 + 1000, headSeq: 42, events,
    inbox: { needsYou: 0, review: 0 }, usage: null,
    nodeLabel: (id) => LABELS[id] ?? id, workspaceLabel: (id) => (id === 'w1' ? 'api' : id),
    ...extra,
  }
}

describe('buildBrief', () => {
  test('one fixture sequence produces every category, in display order, with click targets', () => {
    const brief = buildBrief(input([
      ev('hook.UserPromptSubmit', 'a', { status: 'working' }),
      ev('hook.Stop', 'a', { status: 'done' }),
      ev('hook.Stop', 'a', { status: 'done' }),
      ev('hook.Stop', 'c', { status: 'done' }),
      ev('hook.Notification', 'c', { status: 'blocked', notificationType: 'permission_prompt' }),
      ev('hook.Notification', 'b', { status: 'waiting' }),
      ev('pty.exit', 't', { code: 1, reason: 'self' }),
      ev('pty.exit', 't', { code: 2, reason: 'self' }),
      ev('pty.exit', 'x', { code: -1, reason: 'closed' }), // closing a node is not a failure
      ev('test.fail', null, { name: 'unit' }),
      ev('checkpoint.created', null, { seq: 1 }, 'w1'),
      ev('checkpoint.created', null, { seq: 2 }, 'w1'),
      ev('checkpoint.rewound', null, { seq: 1 }, 'w1'),
      ev('agent.restored', 'a', { agentId: 'claude' }),
    ], {
      inbox: { needsYou: 2, review: 1 },
      usage: { calls: 3, inputTokens: 12_345, outputTokens: 678, costMicros: 420_000, unpriced: 0 },
    }))
    expect(brief.lines.map((l) => [l.category, l.text, l.target])).toEqual([
      ['stuck', 'Build in web needs your input', { kind: 'node', nodeId: 'b' }],
      ['stuck', 'Codex in api is waiting for permission', { kind: 'node', nodeId: 'c' }],
      ['gates', '2 approval or blocked tasks waiting in the Inbox', { kind: 'inbox' }],
      ['gates', '1 task ready for review', { kind: 'inbox' }],
      ['tests', 'A test run failed', { kind: 'inbox' }],
      ['tests', 'Terminal in api exited with code 2 (2 times)', { kind: 'node', nodeId: 't' }],
      ['restored', 'Claude in api was restored after the server restart', { kind: 'node', nodeId: 'a' }],
      ['finished', 'Claude in api finished 2 turns', { kind: 'node', nodeId: 'a' }],
      ['finished', 'Codex in api finished 1 turn', { kind: 'node', nodeId: 'c' }],
      ['checkpoints', '2 checkpoints, 1 rewind in api', { kind: 'diff', workspaceId: 'w1' }],
      ['cost', '12.3k input / 678 output tokens across 3 calls, $0.42', null],
    ])
    expect(brief).toMatchObject({ since: T0, generatedAt: T0 + 1000, headSeq: 42 })
  })

  test('a later status or a pty exit clears "stuck"', () => {
    const brief = buildBrief(input([
      ev('hook.Notification', 'a', { status: 'waiting' }),
      ev('hook.UserPromptSubmit', 'a', { status: 'working' }),
      ev('hook.Notification', 'b', { status: 'blocked' }),
      ev('pty.exit', 'b', { code: 0, reason: 'self' }),
    ]))
    expect(brief.lines).toEqual([])
  })

  test('deterministic: same input, same output; unknown prices are flagged', () => {
    const events = [ev('hook.Stop', 'c'), ev('hook.Stop', 'a')]
    const usage = { calls: 1, inputTokens: 5, outputTokens: 5, costMicros: 0, unpriced: 1 }
    const one = buildBrief(input(events, { usage }))
    expect(buildBrief(input([...events].reverse(), { usage }))).toEqual(one)
    expect(one.lines.at(-1)?.text).toBe('5 input / 5 output tokens across 1 call, $0.00+ (some prices unknown)')
  })

  test('compactCount', () => {
    expect([compactCount(999), compactCount(1500), compactCount(2_500_000)]).toEqual(['999', '1.5k', '2.5M'])
  })
})

describe('renderBriefText (Telegram)', () => {
  test('headings + bullets, empty brief says so', () => {
    const brief = buildBrief(input([ev('hook.Stop', 'a'), ev('hook.Notification', 'b', { status: 'waiting' })]))
    expect(renderBriefText(brief, 'Mon 08:00')).toBe(
      'Morning brief since Mon 08:00\n\nNeeds you\n- Build in web needs your input\n\nFinished\n- Claude in api finished 1 turn',
    )
    expect(renderBriefText(buildBrief(input([])), 'Mon 08:00')).toBe('Morning brief: nothing new since Mon 08:00.')
  })
})
