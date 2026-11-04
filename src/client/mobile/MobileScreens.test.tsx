/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { INBOX_ITEMS_PATH, type UnifiedItem } from '../InboxPanel.items'
import { MobileAgents } from './MobileAgents'
import { MobileInbox } from './MobileInbox'
import { tabFromHash } from './MobileApp'

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
const base = { source: 'agent', approvalKind: null, body: null, impact: null, args: null, count: 1 }
const ITEMS: UnifiedItem[] = [
  { ...base, id: 'perm_1', kind: 'gate', source: 'approval', approvalKind: 'agent.permission', title: 'Claude wants to run: Bash(git push)',
    impact: { what: 'Runs Bash(git push)', tier: 'R3', rewindable: false }, actions: ['approve', 'deny', 'ignore', 'snooze', 'always'] },
  { ...base, id: 'gate_1', kind: 'gate', title: 'Run migration', actions: ['approve', 'edit', 'deny', 'ignore', 'snooze'] },
  { ...base, id: 'q1', kind: 'question', title: 'Which branch?', actions: ['reply', 'ignore', 'snooze'] },
  { ...base, id: 'appr_task', kind: 'gate', source: 'approval', approvalKind: 'task.review', title: 'Approval: task.review', actions: ['approve', 'deny', 'ignore', 'snooze'] },
]

function serve(get: (url: string) => unknown, reply: unknown = { ok: true }) {
  const posts: Array<{ url: string; body: Record<string, unknown> }> = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') { posts.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> }); return json(reply) }
    return json(get(url))
  }))
  return posts
}

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('MobileInbox', () => {
  it('offers approve once / deny / reply / snooze, never "always" or edit, and hides task reviews', async () => {
    serve(() => ({ items: ITEMS }))
    render(<MobileInbox pollMs={0} />)
    expect(await screen.findByText('Claude wants to run: Bash(git push)')).toBeTruthy()
    expect(screen.getByText('Runs Bash(git push) · R3 · cannot be rewound')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: 'Approve once' })).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: 'Deny' })).toHaveLength(2)
    expect(screen.queryByRole('button', { name: /always/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /edit/i })).toBeNull()
    expect(screen.queryByText('Approval: task.review')).toBeNull()
    expect(screen.getByText('1 task review need the desktop Inbox.')).toBeTruthy()
  })

  it('calls the same /act endpoint as the desktop Inbox', async () => {
    const posts = serve(() => ({ items: ITEMS }))
    render(<MobileInbox pollMs={0} />)
    fireEvent.click((await screen.findAllByRole('button', { name: 'Approve once' }))[0]!)
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0]).toEqual({ url: `${INBOX_ITEMS_PATH}/act`, body: { id: 'perm_1', action: { type: 'approve' } } })

    fireEvent.click(screen.getAllByRole('button', { name: 'Deny' })[1]!)
    await waitFor(() => expect(posts).toHaveLength(2))
    expect(posts[1]!.body).toEqual({ id: 'gate_1', action: { type: 'deny' } })

    const before = Date.now()
    fireEvent.click(screen.getAllByRole('button', { name: 'Snooze 1h' })[2]!)
    await waitFor(() => expect(posts).toHaveLength(3))
    const snooze = posts[2]!.body as { id: string; action: { type: string; until: number } }
    expect(snooze.id).toBe('q1')
    expect(snooze.action.type).toBe('snooze')
    expect(snooze.action.until).toBeGreaterThanOrEqual(before + 3_600_000)

    fireEvent.click(screen.getByRole('button', { name: 'Reply' }))
    fireEvent.change(screen.getByLabelText('Reply'), { target: { value: 'main' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send reply' }))
    await waitFor(() => expect(posts).toHaveLength(4))
    expect(posts[3]!.body).toEqual({ id: 'q1', action: { type: 'reply', text: 'main' } })
  })
})

describe('MobileAgents', () => {
  const AGENTS = [{ nodeId: 'n1', workspaceId: 'w', workspace: 'Board', title: 'Builder', agentId: 'claude', status: 'waiting', live: true, lastMessage: 'Tests pass. Ship it?', lastAt: 1 }]

  it('shows status + last message and sends a prompt through the outbox', async () => {
    const posts = serve(() => ({ agents: AGENTS }), { message: { id: 'm1', status: 'queued' }, deduped: false })
    render(<MobileAgents pollMs={0} />)
    expect(await screen.findByText('Builder')).toBeTruthy()
    expect(screen.getByText('Needs input')).toBeTruthy()
    expect(screen.getByText('Tests pass. Ship it?')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Send prompt' }))
    fireEvent.change(screen.getByLabelText('Prompt for Builder'), { target: { value: 'yes, ship it' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0]!.url).toBe('/api/outbox')
    expect(posts[0]!.body).toMatchObject({ to: 'n1', body: 'yes, ship it' })
    expect(String(posts[0]!.body.operationId)).toMatch(/^mobile:n1:[\w]+$/)
    expect(await screen.findByText('Queued: delivered when the agent is idle.')).toBeTruthy()
  })
})

describe('tabFromHash', () => {
  it('maps notification links to screens and defaults to the inbox', () => {
    expect(tabFromHash('#agents')).toBe('agents')
    expect(tabFromHash('#brief')).toBe('brief')
    expect(tabFromHash('')).toBe('inbox')
    expect(tabFromHash('#nope')).toBe('inbox')
  })
})
