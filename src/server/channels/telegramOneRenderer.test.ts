// F2-g "one renderer": every outgoing Telegram text (command replies, approvals, Central replies,
// agent notices, the status card) is sent as `telegramMarkdownChunks(text)` with parse_mode HTML.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { ChannelStore } from './channelStore'
import { dispatchTelegramUpdate } from './channelDispatch'
import { createPresenceTracker, startAgentForwarder } from './channelPresence'
import type { SenseEvent } from '../events/eventModel'
import { createStatusCards } from './statusCard'
import { telegramMarkdownChunks } from './telegramSend'
import { TelegramChannelSender, type TelegramSenderFetch } from './telegramSender'

const ENV = () => ({ WEBTERM_TELEGRAM_BOT_TOKEN: '1:TEST' }) as NodeJS.ProcessEnv // test-only fake token
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function newStore(): ChannelStore {
  const root = mkdtempSync(join(tmpdir(), 'webterm-renderer-'))
  dirs.push(root)
  return new ChannelStore(join(root, 'channels.json'))
}

const update = (id: number, text: string): unknown => ({
  update_id: id,
  message: { message_id: id, chat: { id: 100, type: 'private' }, from: { id: 7 }, text },
})

describe('one Telegram renderer', () => {
  it('command, approval, Central and agent-notice replies all leave through the HTML renderer', async () => {
    const store = newStore()
    store.bind('telegram', '100', { projectId: 'ws-1', role: 'owner', userId: '7' })
    const tasks: Promise<void>[] = []
    const deps = {
      store,
      approval: {
        listApprovals: () => [{ id: 'ap_1', projectId: 'ws-1', status: 'pending', kind: 'act <rm>' }],
        getApproval: () => null,
        decideApproval: () => undefined,
        consumeApproval: () => false,
      },
      centralChat: { ask: async () => ({ ok: true as const, text: '**Done** with `a < b` & more' }) },
      background: (task: Promise<void>) => { tasks.push(task) },
      world: () => ({ workspaces: 2, nodes: 3, agentNodes: 1, ledger: null }),
    }
    await dispatchTelegramUpdate(update(1, '/status'), deps)
    await dispatchTelegramUpdate(update(2, `/approve ap_9 ${'a'.repeat(64)} nonce-1234`), deps)
    await dispatchTelegramUpdate(update(3, 'hello central'), deps)
    await Promise.all(tasks)
    // Agent notice: same outbox.
    let emit: (e: SenseEvent) => void = () => {}
    const clock = { t: 0 }
    const presence = createPresenceTracker(() => clock.t)
    clock.t = 10 * 60_000
    startAgentForwarder({ store, presence, subscribe: (_p, fn) => { emit = fn; return () => {} }, describe: () => ({ label: 'Claude <1>', workspace: 'A_b' }) })
    emit({ seq: 9, ts: 1, kind: 'hook.Stop', nodeId: 'n1', workspaceId: 'ws-1', payload: { status: 'done' } } as SenseEvent)

    const rows = store.pendingReplies()
    expect(rows).toHaveLength(4)
    const bodies: Array<Record<string, unknown>> = []
    const fetch: TelegramSenderFetch = async (_url, init) => {
      bodies.push(JSON.parse(init.body) as Record<string, unknown>)
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: bodies.length } }) }
    }
    const result = await new TelegramChannelSender({ store, fetch, env: ENV }).flushOnce()
    expect(result.sent).toBe(4)
    const expected = rows.flatMap((row) => telegramMarkdownChunks(row.text))
    expect(bodies.map((b) => b['text'])).toEqual(expected)
    expect(bodies.every((b) => b['parse_mode'] === 'HTML')).toBe(true)
    expect(bodies.some((b) => String(b['text']).includes('<b>Done</b>'))).toBe(true)
    expect(bodies.some((b) => String(b['text']).includes('Claude &lt;1&gt; finished in'))).toBe(true)
  })

  it('the status card is rendered by the same function', async () => {
    const params: Array<Record<string, unknown>> = []
    const cards = createStatusCards({
      call: async (_a, _m, p) => { params.push(p); return { message_id: 1 } },
      provider: () => ({ level: 'observe', activeWorkers: 1, budgetUsedTokens: 1, budgetLimitTokens: 2 }),
    })
    await cards.refresh({ accountId: 'default', chatId: '1', projectId: null })
    expect(params[0]?.['text']).toBe(telegramMarkdownChunks('Central level: observe\nActive workers: 1\nBudget: 1/2 tokens (50%)')[0])
    expect(params[0]?.['parse_mode']).toBe('HTML')
  })
})
