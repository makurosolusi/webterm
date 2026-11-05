/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { approveLabel, INBOX_ITEMS_PATH, InboxItems, snoozeUntil, type UnifiedItem } from './InboxPanel.items'

/** Visible tooltip of `el` (focus opens it); the label is the tooltip, not a native `title`. */
const tipOf = (el: Element): string | null => {
  fireEvent.focus(el)
  const text = document.querySelector('[role="tooltip"]')?.textContent ?? null
  fireEvent.blur(el)
  return text
}

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
const base = { source: 'agent', approvalKind: null, body: null, impact: null, args: null, count: 1 }
const ITEMS: UnifiedItem[] = [
  { ...base, id: 'perm_1', kind: 'gate', source: 'approval', approvalKind: 'agent.permission', title: 'brisk-otter wants to run: Bash(git push)',
    impact: { what: 'Runs Bash(git push), which reaches outside this machine', tier: 'R3', rewindable: false }, actions: ['approve', 'deny', 'ignore', 'snooze', 'always'] },
  { ...base, id: 'gate_1', kind: 'gate', title: 'Run migration', args: { table: 'users' }, actions: ['approve', 'edit', 'deny', 'ignore', 'snooze'] },
  { ...base, id: 'q1', kind: 'question', title: 'Which branch?', actions: ['reply', 'ignore', 'snooze'] },
  { ...base, id: 'n1', kind: 'notify', title: 'Build finished', count: 3, actions: ['ignore', 'snooze'] },
  // A task-review approval keeps its APPROVE-phrase dialog in the sections: not repeated here.
  { ...base, id: 'appr_task', kind: 'gate', source: 'approval', approvalKind: 'task.review', title: 'Approval: task.review', actions: ['approve', 'deny', 'ignore', 'snooze'] },
]

function serve() {
  const posts: Array<{ url: string; body: Record<string, unknown> }> = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      posts.push({ url, body })
      return json(url.endsWith('/batch') ? { results: (body.ids as string[]).map((id) => ({ id, status: id === 'perm_1' ? 409 : 200, body: id === 'perm_1' ? { error: 'needs_individual_review' } : {} })) } : { ok: true })
    }
    return json({ items: ITEMS })
  }))
  return posts
}

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('InboxItems', () => {
  it('renders every kind with its actions and the impact line; other approvals stay in the sections', async () => {
    serve()
    render(<InboxItems pollMs={0} />)
    expect(await screen.findByText('brisk-otter wants to run: Bash(git push)')).toBeTruthy()
    expect(screen.getByText('Runs Bash(git push), which reaches outside this machine · R3 · cannot be rewound')).toBeTruthy()
    expect(screen.getByText('Build finished (×3)')).toBeTruthy()
    expect(screen.queryByText('Approval: task.review')).toBeNull()
    expect(screen.getAllByText('Approve once')).toHaveLength(2)
    expect(screen.getAllByText('Always allow this pattern')).toHaveLength(1)
    expect(tipOf(screen.getByRole('button', { name: 'Always allow this pattern' }))).toBe('Saves a permanent rule (only from this window, never from Telegram)')
    expect(screen.getByText('Dismiss')).toBeTruthy()
  })

  it('approve, always and ignore post one action each', async () => {
    const posts = serve()
    render(<InboxItems pollMs={0} />)
    fireEvent.click((await screen.findAllByText('Approve once'))[0])
    await waitFor(() => expect(posts).toHaveLength(1))
    fireEvent.click(screen.getByText('Always allow this pattern'))
    await waitFor(() => expect(posts).toHaveLength(2))
    fireEvent.click(screen.getByText('Dismiss'))
    await waitFor(() => expect(posts).toHaveLength(3))
    expect(posts.map((p) => [p.url, p.body])).toEqual([
      [`${INBOX_ITEMS_PATH}/act`, { id: 'perm_1', action: { type: 'approve' } }],
      [`${INBOX_ITEMS_PATH}/act`, { id: 'perm_1', action: { type: 'always' } }],
      [`${INBOX_ITEMS_PATH}/act`, { id: 'n1', action: { type: 'ignore' } }],
    ])
  })

  it('edit sends the edited args; reply sends the text', async () => {
    const posts = serve()
    render(<InboxItems pollMs={0} />)
    fireEvent.click(await screen.findByText('Edit'))
    fireEvent.change(screen.getByLabelText('Edit arguments'), { target: { value: '{"table":"users","dryRun":true}' } })
    fireEvent.click(screen.getByText('Approve with edits'))
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0].body).toEqual({ id: 'gate_1', action: { type: 'edit', args: { table: 'users', dryRun: true } } })
    fireEvent.click(await screen.findByText('Reply'))
    fireEvent.change(screen.getByLabelText('Reply to the agent'), { target: { value: 'use main' } })
    fireEvent.click(screen.getByText('Send reply'))
    await waitFor(() => expect(posts).toHaveLength(2))
    expect(posts[1].body).toEqual({ id: 'q1', action: { type: 'reply', text: 'use main' } })
  })

  it('snooze posts the chosen time; batch approve reports the R3 refusal', async () => {
    const posts = serve()
    const now = () => Date.UTC(2026, 10, 4, 10, 0, 0)
    render(<InboxItems pollMs={0} now={now} />)
    fireEvent.click(await screen.findByLabelText('Snooze Which branch? for 1 hour'))
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0].body).toEqual({ id: 'q1', action: { type: 'snooze', until: now() + 3_600_000 } })
    fireEvent.click(screen.getByLabelText('Select brisk-otter wants to run: Bash(git push)'))
    fireEvent.click(screen.getByLabelText('Select Run migration'))
    fireEvent.click(screen.getByText('Approve selected'))
    await waitFor(() => expect(posts).toHaveLength(2))
    expect(posts[1]).toEqual({ url: `${INBOX_ITEMS_PATH}/batch`, body: { ids: ['perm_1', 'gate_1'], action: { type: 'approve' } } })
    expect(await screen.findByText('1 item(s) cannot be rewound and must be approved one by one.')).toBeTruthy()
  })

  it('snooze presets', () => {
    const t = new Date(2026, 10, 4, 22, 30).getTime()
    expect(snoozeUntil('1h', t)).toBe(t + 3_600_000)
    expect(snoozeUntil('tomorrow', t)).toBe(new Date(2026, 10, 5, 9, 0).getTime())
  })

  it('a PR review draft is approved with a "Post review" button that approves that item only', async () => {
    expect(approveLabel({ kind: 'gate', source: 'prreview' })).toBe('Post review')
    expect(approveLabel({ kind: 'gate', source: 'dag' })).toBe('Approve once')
    expect(approveLabel({ kind: 'review', source: 'routines' })).toBe('Accept')
    const draft: UnifiedItem = { ...base, id: 'gate_pr', kind: 'gate', source: 'prreview', title: 'Post review to o/r#7: 2 findings',
      impact: { what: 'Posts one review with 1 inline comment to o/r#7 on GitHub', tier: 'R3', rewindable: false }, actions: ['approve', 'edit', 'deny', 'ignore', 'snooze'] }
    const posts: Array<{ url: string; body: unknown }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') { posts.push({ url, body: JSON.parse(String(init.body)) }); return json({ ok: true }) }
      return json({ items: [draft] })
    }))
    render(<InboxItems pollMs={0} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Post review' }))
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0]).toEqual({ url: `${INBOX_ITEMS_PATH}/act`, body: { id: 'gate_pr', action: { type: 'approve' } } })
    expect(screen.queryByRole('button', { name: 'Approve once' })).toBeNull()
  })
})
