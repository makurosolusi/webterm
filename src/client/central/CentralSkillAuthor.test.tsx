/** @vitest-environment jsdom */
// The Central skill author in the UI: the Skills tab buttons that open a NEW author-mode Central chat (with the
// target skill), the Drafts panel of Central's own proposals, and the chat's role banner (author mode only).
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import ChatConversationView from '../chat/chatConversation'
import { conversationLabel, type ChatClient, type ChatConversation } from '../chat/chatTypes'
import { InboxApiError } from '../inboxTypes'
import { SKILLS_OFF } from './centralControlApi'
import type { SkillReviewRow } from './centralControlTypes'
import { notifyCentralSkillAuthorActivity } from './centralSkillAuthor.events'
import { fakeClient } from './centralFixtures.testutil'
import SkillLibrary from './SkillLibrary'
import { centralDraftsOf } from './skillAuthorModel'

const opened = vi.hoisted(() => vi.fn())
vi.mock('../chat/chatFeed', async (orig) => ({ ...(await orig<typeof import('../chat/chatFeed')>()), requestOpenConversation: opened }))
vi.mock('../central/centralModel', async (orig) => ({
  ...(await orig<typeof import('../central/centralModel')>()),
  fetchCentralModel: vi.fn(async () => ({ alias: 'opus', effort: 'medium', tier: 'T3', pending: false, override: null })),
}))
vi.mock('../central/centralControlApi', async (orig) => ({
  ...(await orig<typeof import('../central/centralControlApi')>()),
  fetchCentralContext: vi.fn(async () => ({ tokens: 1, window: 100, percent: 1, lastCompaction: null })),
}))

beforeAll(() => { globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver })
afterEach(() => { cleanup(); opened.mockClear() })

const row = (over: Partial<SkillReviewRow['record']> = {}, extra: Partial<SkillReviewRow> = {}): SkillReviewRow => ({
  record: { name: 'webterm-rule', version: '1', sha256: null, status: 'active', origin: 'human', audience: 'central', caps: [], createdAt: 1, proposedBy: 'human:root', approvedBy: 'human:root', approvedAt: 1, evalScore: null, enabled: true, ...over },
  lint: { ok: true, findings: [] }, diff: '', canRollback: false, description: 'Be brief.', body: '1. Be brief.', ...extra,
})
const draft = (over: Partial<SkillReviewRow['record']> = {}, extra: Partial<SkillReviewRow> = {}) =>
  row({ name: 'webterm-new-rule', version: '1', status: 'pending_approval', origin: 'central', proposedBy: 'central:chat1', ...over }, { diff: '+ a new step', description: 'New.', ...extra })

const CREATED: ChatConversation = { id: 'central:chat:a1', scope: 'chat:a1', projectId: null, activeTurnId: null, lastEventSeq: 0, lastMessageSeq: 0, updatedAt: 1, title: null, mode: 'skill-author', skillTarget: null }
function library(rows: SkillReviewRow[], over = {}) {
  const chat = { createConversation: vi.fn(async () => CREATED) }
  const client = fakeClient({ listSkills: vi.fn(async () => rows), ...over })
  const { unmount } = render(<SkillLibrary client={client} chat={chat} />)
  return { client, chat, unmount }
}
const section = async (name: string) => within(await screen.findByRole('region', { name }))

describe('Write / Edit with an agent (Central skills)', () => {
  it('Write opens a NEW author-mode Central conversation with no target, then asks the chat to show it', async () => {
    const { chat } = library([row()])
    fireEvent.click((await section('Central skills')).getByRole('button', { name: 'Write with an agent (Central)' }))
    await waitFor(() => expect(opened).toHaveBeenCalledWith(CREATED))
    expect(chat.createConversation).toHaveBeenCalledWith({ mode: 'skill-author' })
  })

  it('Ask the agent to revise on a central skill passes its name as the target', async () => {
    const { chat } = library([row()])
    fireEvent.click(await screen.findByRole('button', { name: 'View webterm-rule 1' }))
    fireEvent.click(screen.getByRole('button', { name: 'Ask the agent to revise webterm-rule' }))
    await waitFor(() => expect(opened).toHaveBeenCalled())
    expect(chat.createConversation).toHaveBeenCalledWith({ mode: 'skill-author', skillTarget: 'webterm-rule' })
  })

  it('a built-in skill has no revise button; its variant opens the author with the built-in as a reference target', async () => {
    const { chat } = library([row({ origin: 'builtin', name: 'webterm-core', proposedBy: null })])
    fireEvent.click(await screen.findByRole('button', { name: 'View webterm-core 1' }))
    expect(screen.queryByRole('button', { name: 'Ask the agent to revise webterm-core' })).toBeNull()
    expect(screen.getByText(/Tell the agent to base the new skill on webterm-core/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Ask the agent for a variant webterm-core' }))
    await waitFor(() => expect(chat.createConversation).toHaveBeenCalledWith({ mode: 'skill-author', skillTarget: 'webterm-core' }))
  })

  it('shows a failed start as an alert and the button works again', async () => {
    const chat = { createConversation: vi.fn().mockRejectedValueOnce(new InboxApiError('x', 503, 'central_runtime_off')).mockResolvedValue(CREATED) }
    render(<SkillLibrary client={fakeClient({ listSkills: vi.fn(async () => [row()]) })} chat={chat} />)
    const button = (await section('Central skills')).getByRole('button', { name: 'Write with an agent (Central)' })
    fireEvent.click(button)
    expect((await screen.findByRole('alert')).textContent).toContain('Could not open the skill author')
    expect(opened).not.toHaveBeenCalled()
    fireEvent.click(button)
    await waitFor(() => expect(opened).toHaveBeenCalledWith(CREATED))
  })
})

describe('Drafts from Central', () => {
  it('keeps only open drafts Central proposed for Central skills (canvas drafts live in the canvas panel)', () => {
    const mine = draft()
    const canvasDraft = draft({ name: 'webterm-b', audience: 'canvas' })
    const rows = [mine, draft({ origin: 'agent', proposedBy: 'agent:n1', name: 'webterm-a' }), canvasDraft, draft({ name: 'webterm-c', status: 'rejected' }), row()]
    expect(centralDraftsOf(rows)).toEqual([mine])
  })

  it('lists a draft with its diff, in the Central section, once (not again in the general review list)', async () => {
    library([row(), draft()])
    const drafts = within(await screen.findByLabelText('Drafts from Central'))
    expect(drafts.getByText('webterm-new-rule')).toBeTruthy()
    expect(drafts.getByText(/a new step/)).toBeTruthy()
    expect(screen.getAllByText(/a new step/)).toHaveLength(1)
  })

  it('approves in one click (the human gate is the click itself)', async () => {
    const { client } = library([draft()])
    const approve = await screen.findByRole('button', { name: 'Approve skill webterm-new-rule 1' }) as HTMLButtonElement
    expect(approve.disabled).toBe(false)
    fireEvent.click(approve)
    await waitFor(() => expect(client.approveSkill).toHaveBeenCalledWith('webterm-new-rule', '1'))
  })

  it('Reject is one click', async () => {
    const { client } = library([draft()])
    fireEvent.click(await screen.findByRole('button', { name: 'Reject webterm-new-rule 1' }))
    await waitFor(() => expect(client.rejectSkill).toHaveBeenCalledWith('webterm-new-rule', '1'))
  })

  it('has no Edit on a Central draft', async () => {
    library([draft()])
    await screen.findByRole('button', { name: 'Reject webterm-new-rule 1' })
    expect(screen.queryByRole('button', { name: /^Edit/ })).toBeNull()
  })

  it('with no drafts there is no card; the toolbar Refresh and a finished author chat turn reload (no polling)', async () => {
    const listSkills = vi.fn(async () => [row()])
    library([], { listSkills })
    await waitFor(() => expect((screen.getByRole('button', { name: 'Refresh skills' }) as HTMLButtonElement).disabled).toBe(false))
    const refresh = screen.getByRole('button', { name: 'Refresh skills' })
    expect(screen.queryByLabelText('Drafts from Central')).toBeNull()
    const base = listSkills.mock.calls.length
    fireEvent.click(refresh)
    await waitFor(() => expect(listSkills.mock.calls.length).toBe(base + 1))
    act(() => notifyCentralSkillAuthorActivity())
    await waitFor(() => expect(listSkills.mock.calls.length).toBe(base + 2))
  })

  it('a failed refresh shows one error with a working retry (the panel does not repeat the library error)', async () => {
    const listSkills = vi.fn().mockResolvedValueOnce([row()]).mockRejectedValueOnce(new InboxApiError('boom', 500, 'x')).mockResolvedValue([draft()])
    library([], { listSkills })
    await waitFor(() => expect((screen.getByRole('button', { name: 'Refresh skills' }) as HTMLButtonElement).disabled).toBe(false))
    const refresh = screen.getByRole('button', { name: 'Refresh skills' })
    fireEvent.click(refresh)
    expect((await screen.findAllByRole('alert'))).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect((await screen.findAllByText('webterm-new-rule')).length).toBeGreaterThan(0)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('the first draft proposed after a chat turn appears without a manual refresh (subscription lives while 0 drafts)', async () => {
    const listSkills = vi.fn().mockResolvedValueOnce([row()]).mockResolvedValue([row(), draft()])
    library([], { listSkills })
    await screen.findByRole('button', { name: 'Refresh skills' })
    await waitFor(() => expect(listSkills).toHaveBeenCalledTimes(1))
    act(() => notifyCentralSkillAuthorActivity())
    await waitFor(() => expect(listSkills).toHaveBeenCalledTimes(2))
    expect(await screen.findByRole('button', { name: '1 draft to review' })).toBeTruthy()
    expect(within(screen.getByLabelText('Drafts from Central')).getByText('webterm-new-rule')).toBeTruthy()
  })

  it('unmounting the library releases the subscription', async () => {
    const listSkills = vi.fn(async () => [row()])
    const { unmount } = library([], { listSkills })
    await screen.findByRole('button', { name: 'Refresh skills' })
    const n = listSkills.mock.calls.length
    unmount()
    act(() => notifyCentralSkillAuthorActivity())
    await new Promise((r) => setTimeout(r, 20))
    expect(listSkills.mock.calls.length).toBe(n)
  })

  it('has no panel and no author button while skills are off', async () => {
    library([], { listSkills: vi.fn().mockRejectedValue(new InboxApiError('off', 503, SKILLS_OFF)) })
    await screen.findByRole('status')
    expect(screen.queryByLabelText('Drafts from Central')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Write with an agent (Central)' })).toBeNull()
  })
})

describe('the author chat', () => {
  const base: ChatConversation = { id: 'central:chat:a1', scope: 'chat:a1', projectId: null, activeTurnId: null, lastEventSeq: 0, lastMessageSeq: 0, updatedAt: 1, title: null }
  function mount(conversation: ChatConversation) {
    const client: ChatClient = { listConversations: vi.fn(), createConversation: vi.fn(), sendMessage: vi.fn(), cancelTurn: vi.fn(), listMessages: vi.fn(async () => []) }
    const host = { centralEnabled: false, newChat: vi.fn(), showHistory: vi.fn() }
    return render(<TooltipProvider><ChatConversationView conversation={conversation} client={client} streamFactory={() => ({ close: () => {} })} commands={host} /></TooltipProvider>)
  }

  it('shows the role banner (purpose, tools limited, drafts need approval, target) and the Limited tools chip in author mode', () => {
    mount({ ...base, mode: 'skill-author', skillTarget: 'webterm-rule' })
    const banner = within(screen.getByRole('complementary', { name: 'Skill author' }))
    expect(banner.getByText(/title, steps and checks before writing/)).toBeTruthy()
    expect(banner.getByText(/Can list, read and draft skills and read public web pages \(read-only\)\. Cannot .*use the canvas, run agents, use memory/)).toBeTruthy()
    expect(banner.getByText(/need your approval in the Skills tab/)).toBeTruthy()
    expect(banner.getByText('Editing webterm-rule.')).toBeTruthy()
    expect(screen.getByText('Limited tools')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Permission mode/ })).toBeNull()
  })

  it('shows neither in an ordinary Central chat', () => {
    mount(base)
    expect(screen.queryByRole('complementary', { name: 'Skill author' })).toBeNull()
    expect(screen.queryByText('Limited tools')).toBeNull()
    expect(screen.getByRole('button', { name: /^Permission mode/ })).toBeTruthy()
  })

  it('is labelled Skill author in the conversation list (with the target when editing)', () => {
    expect(conversationLabel({ ...base, mode: 'skill-author', title: 'make a skill' })).toBe('Skill author')
    expect(conversationLabel({ ...base, mode: 'skill-author', skillTarget: 'webterm-rule' })).toBe('Skill author: webterm-rule')
    expect(conversationLabel({ ...base, title: 'make a skill' })).toBe('make a skill')
  })
})
