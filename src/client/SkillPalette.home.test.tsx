/** @vitest-environment jsdom */
// The canvas Skills panel as the full home of canvas skills: header + Write with an agent, filters, inline switch,
// detail with revise / add to canvas, drafts with their review card, the activity subscription, refresh, and the pointers.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CONFIRM_PHRASE } from '../shared/approvalConfirm'
import { notifySkillAuthorActivity } from './agentChat/skillAuthor.events'
import { SKILLS_OFF } from './central/centralControlApi'
import { InboxApiError } from './inboxTypes'
import { NodeActionsProvider, type NodeActions } from './nodeActions'
import SkillPalette from './SkillPalette'

const h = vi.hoisted(() => ({ request: vi.fn(), openCentralTab: vi.fn() }))
vi.mock('./inboxTransport', async (orig) => ({ ...(await orig<object>()), request: h.request }))
vi.mock('./workspaceSave.notice', () => ({ showNotice: vi.fn(), closeNotice: vi.fn() }))
vi.mock('./secondarySideBar.store', async (orig) => ({ ...(await orig<object>()), openCentralTab: h.openCentralTab }))

// test-only fixtures
const row = (name: string, record: Record<string, unknown> = {}) => ({
  record: { name, version: '3', status: 'active', audience: 'canvas', origin: 'human', enabled: true, caps: [], createdAt: 1, ...record },
  description: `About ${name}`, lint: { ok: true, findings: [] }, diff: '+ new step', canRollback: false, body: '1. Do it.',
})
const DRAFT = row('webterm-new', { status: 'pending_approval', origin: 'agent', proposedBy: 'agent:n1', version: '1' })
const LIBRARY = [row('webterm-deploy'), row('webterm-core', { origin: 'builtin' }), row('central-only', { audience: 'central' }), row('webterm-off', { enabled: false })]

let openSkillAuthor: ReturnType<typeof vi.fn>
let addSkillNode: ReturnType<typeof vi.fn>
function mount(withBoard = true) {
  const value = { onSession: vi.fn(), onToggleHideLinks: vi.fn(), ...(withBoard ? { openSkillAuthor, addSkillNode } : {}) } as unknown as NodeActions
  return render(<NodeActionsProvider value={value}><SkillPalette nodes={[]} edges={[]} /></NodeActionsProvider>)
}
const listed = async () => (await screen.findByRole('list', { name: 'Canvas skills' }))

beforeEach(() => {
  openSkillAuthor = vi.fn(() => 'n1')
  addSkillNode = vi.fn(() => ({ status: 'added' }))
  h.request.mockResolvedValue(LIBRARY)
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('header', () => {
  it('has a title, a subtitle and Write with an agent that opens the author on the board', async () => {
    mount()
    await listed()
    expect(screen.getByRole('heading', { name: 'Skills' })).toBeTruthy()
    expect(screen.getByText('For agents on the canvas')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Write with an agent' }))
    expect(openSkillAuthor).toHaveBeenCalledWith()
  })

  it('without a board the button is disabled and says why', async () => {
    mount(false)
    await listed()
    expect((screen.getByRole('button', { name: 'Write with an agent' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('Open a workspace to write a skill.')).toBeTruthy()
  })

  it('Refresh skills loads the list again', async () => {
    mount()
    await listed()
    const before = h.request.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: 'Refresh skills' }))
    await waitFor(() => expect(h.request.mock.calls.length).toBeGreaterThan(before))
  })

  it('points to Control > Skills for the rules of Central itself', async () => {
    mount()
    await listed()
    expect(screen.getByText(/Rules for Central itself are in Control > Skills\./)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open Central skills' }))
    expect(h.openCentralTab).toHaveBeenCalledWith('skills')
  })
})

describe('rows', () => {
  it('lists canvas skills only, with Built-in and Disabled marks and the filter counts', async () => {
    mount()
    const ul = await listed()
    expect(within(ul).getAllByRole('listitem')).toHaveLength(3)
    expect(screen.queryByText('central-only')).toBeNull()
    expect(within(ul).getByText('Built-in')).toBeTruthy()
    expect(within(ul).getByText('Disabled')).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Active/ }).textContent).toContain('2')
    fireEvent.click(screen.getByRole('button', { name: /^Disabled/ }))
    expect(within(ul).getAllByRole('listitem')).toHaveLength(1)
  })

  it('a switched-off skill cannot be added or dragged', async () => {
    mount()
    await listed()
    expect(screen.queryByRole('button', { name: /^Add webterm-off/ })).toBeNull()
    expect(screen.getByRole('button', { name: /^Add webterm-deploy/ }).getAttribute('draggable')).toBe('true')
  })

  it('the inline switch turns a skill off through the same API as the library', async () => {
    mount()
    await listed()
    fireEvent.click(screen.getByRole('switch', { name: 'Enabled: webterm-deploy' }))
    await waitFor(() => expect(h.request.mock.calls.some(([p]) => String(p).includes('/webterm-deploy/disable'))).toBe(true))
  })

  it('the detail opens under the row; revise asks the author about that skill, Add to canvas adds it', async () => {
    mount()
    await listed()
    fireEvent.click(screen.getByRole('button', { name: 'View webterm-deploy 3' }))
    fireEvent.click(screen.getByRole('button', { name: 'Ask the agent to revise' }))
    expect(openSkillAuthor).toHaveBeenCalledWith('webterm-deploy')
    fireEvent.click(screen.getByRole('button', { name: 'Add to canvas' }))
    expect(addSkillNode).toHaveBeenCalledWith({ name: 'webterm-deploy', version: '3' })
  })

  it('a built-in only offers a variant', async () => {
    mount()
    await listed()
    fireEvent.click(screen.getByRole('button', { name: 'View webterm-core 3' }))
    fireEvent.click(screen.getByRole('button', { name: 'Ask the agent for a variant' }))
    expect(openSkillAuthor).toHaveBeenCalledWith('webterm-core')
  })
})

describe('drafts', () => {
  it('shows a canvas draft with its review card and a badge', async () => {
    h.request.mockResolvedValue([...LIBRARY, DRAFT])
    mount()
    await listed()
    expect(screen.getByText('1 draft to review')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Approve skill webterm-new 1' })).toBeTruthy()
    expect(screen.getByLabelText('Diff').textContent).toContain('+ new step')
  })

  it('approval needs the typed phrase, and goes through the same approve API', async () => {
    h.request.mockResolvedValue([...LIBRARY, DRAFT])
    mount()
    const approve = await screen.findByRole('button', { name: 'Approve skill webterm-new 1' }) as HTMLButtonElement
    expect(approve.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(/Type/i), { target: { value: CONFIRM_PHRASE } })
    fireEvent.click(approve)
    await waitFor(() => expect(h.request.mock.calls.some(([p]) => String(p).includes('/webterm-new/approve'))).toBe(true))
  })

  it('reloads when a canvas author chat finishes a turn, even with no draft yet', async () => {
    mount()
    await listed()
    expect(screen.queryByText(/to review/)).toBeNull()
    h.request.mockResolvedValue([...LIBRARY, DRAFT])
    act(() => notifySkillAuthorActivity('n1'))
    expect(await screen.findByText('1 draft to review')).toBeTruthy()
  })
})

describe('states', () => {
  it('empty: says so and offers Write with an agent in place of the old Skills tab button', async () => {
    h.request.mockResolvedValue([row('central-only', { audience: 'central' })])
    mount()
    expect(await screen.findByText('No canvas skills yet')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Open Skills tab' })).toBeNull()
    fireEvent.click(screen.getAllByRole('button', { name: 'Write with an agent' }).at(-1) as HTMLElement)
    expect(openSkillAuthor).toHaveBeenCalled()
  })

  it('off: Central skills are off', async () => {
    h.request.mockRejectedValue(new InboxApiError('off', 503, SKILLS_OFF))
    mount()
    expect(await screen.findByText(/Central skills are off/)).toBeTruthy()
  })
})
