/** @vitest-environment jsdom */
// The Central chat's `/` menu end to end: ChatPanel (side bar mount) + the Central control panel.
import { act, cleanup, createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ChatPanel from '../ChatPanel'
import type { ChatClient, ChatConversation } from '../chat/chatTypes'
import type { StreamFactory } from '../chat/chatConversation'
import { InboxApiError } from '../inboxTypes'
import { reloadSideBarFromStorage, setSideBar, useSideBar } from '../secondarySideBar.store'
import CentralControlPanel from './CentralControlPanel'
import { fakeClient } from './centralFixtures.testutil'

const skills = vi.hoisted(() => ({ list: vi.fn() }))
vi.mock('./centralControlApi', async (orig) => ({ ...(await orig<typeof import('./centralControlApi')>()), listActiveSkills: skills.list }))
vi.mock('../api', async (orig) => ({
  ...(await orig<typeof import('../api')>()),
  fetchWorkspaces: vi.fn(async () => [{ id: 'w1', name: 'webterm' }, { id: 'w2', name: 'nodeterm' }]),
}))

const CONV: ChatConversation = {
  id: 'central:global', scope: 'global', projectId: null, activeTurnId: null,
  lastEventSeq: 0, lastMessageSeq: 0, updatedAt: Date.now(), title: 'Ops',
}
const CREATED: ChatConversation = { ...CONV, id: 'central:chat:new', scope: 'chat:new', title: null }

function makeClient(): ChatClient {
  return {
    listConversations: vi.fn(async () => ({ items: [CONV], nextOffset: null })),
    createConversation: vi.fn(async () => CREATED),
    listMessages: vi.fn(async () => []),
    sendMessage: vi.fn(async () => ({ messageId: 'm9', seq: 1, turnId: 't9', status: 'queued' as const })),
    cancelTurn: vi.fn(async () => ({ status: 'cancelled' as const })),
  }
}
const streams: StreamFactory = () => ({ close: () => {} })

function SideBarView() {
  const { open, view } = useSideBar()
  return <output data-testid="sidebar">{open ? view : 'closed'}</output>
}

let host: HTMLElement
beforeEach(() => {
  localStorage.clear()
  reloadSideBarFromStorage()
  skills.list.mockReset()
  skills.list.mockResolvedValue([{ name: 'webterm-demo', description: 'Summarize project status' }])
  host = document.createElement('div')
  document.body.appendChild(host)
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 0) as unknown as number)
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id))
})
afterEach(() => {
  cleanup()
  host.remove()
  vi.unstubAllGlobals()
  localStorage.clear()
})

async function setup(centralEnabled = true) {
  const client = makeClient()
  const control = fakeClient()
  render(<>
    <ChatPanel open embedded compact actionsHost={host} client={client} streamFactory={streams} centralEnabled={centralEnabled} />
    <CentralControlPanel open enabled client={control} />
    <SideBarView />
  </>)
  await screen.findByLabelText('Message the central agent')
  return { client, control }
}
const box = (): HTMLTextAreaElement => screen.getByLabelText('Message the central agent') as HTMLTextAreaElement
const type = (text: string): void => { fireEvent.change(box(), { target: { value: text } }) }
const key = (k: string): void => { fireEvent.keyDown(box(), { key: k }) }
const options = async (): Promise<string[]> => {
  const list = await screen.findByRole('listbox', { name: 'Commands and skills' })
  await waitFor(() => expect(within(list).queryAllByRole('option').length).toBeGreaterThan(0))
  return within(list).getAllByRole('option').map((o) => o.querySelector('.cmp-name')!.textContent!)
}
const send = async (text: string): Promise<void> => { type(text); await act(async () => { key('Enter') }) }

describe('Central chat / menu', () => {
  it('"/" lists Central commands with descriptions, hints and approved skills', async () => {
    await setup()
    type('/')
    const names = await options()
    for (const n of ['/new', '/history', '/help', '/status', '/approvals', '/halt', '/projects', '/nodes', '/plan']) expect(names).toContain(n)
    await waitFor(async () => expect(await options()).toContain('/webterm-demo'))
    const nodes = screen.getAllByRole('option').find((o) => o.textContent?.startsWith('/nodes'))!
    expect(nodes.textContent).toContain('<project>')
    expect(nodes.textContent).toContain('Ask Central for the nodes of a project')
    const skill = screen.getAllByRole('option').find((o) => o.textContent?.startsWith('/webterm-demo'))!
    expect(skill.textContent).toContain('Summarize project status')
  })

  it('filters by what is typed, best match first', async () => {
    await setup()
    type('/app')
    expect((await options())[0]).toBe('/approvals')
  })

  it('/new starts a new chat and is not sent', async () => {
    const { client } = await setup()
    await send('/new')
    await waitFor(() => expect(client.createConversation).toHaveBeenCalledTimes(1))
    expect(client.sendMessage).not.toHaveBeenCalled()
  })

  it('/history opens the conversation list and is not sent', async () => {
    const { client } = await setup()
    expect(screen.queryByRole('navigation', { name: 'Conversations' })).toBeNull()
    await send('/history')
    expect(screen.getByRole('navigation', { name: 'Conversations' })).not.toBeNull()
    expect(client.sendMessage).not.toHaveBeenCalled()
  })

  it('/approvals opens the Central tab on Approvals', async () => {
    const { client, control } = await setup()
    setSideBar({ open: false, view: 'chat' })
    await send('/approvals')
    expect(screen.getByTestId('sidebar').textContent).toBe('central')
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Approvals' }).getAttribute('aria-selected')).toBe('true'))
    await waitFor(() => expect(control.listApprovals).toHaveBeenCalled())
    expect(client.sendMessage).not.toHaveBeenCalled()
  })

  it('/halt asks for the kill-switch confirmation and does not halt by itself', async () => {
    const { client, control } = await setup()
    fireEvent.click(screen.getByRole('tab', { name: 'Memory' }))
    await send('/halt')
    expect(await screen.findByRole('alertdialog')).not.toBeNull()
    expect(screen.getByRole('tab', { name: 'Control' }).getAttribute('aria-selected')).toBe('true')
    expect(control.halt).not.toHaveBeenCalled()
    expect(client.sendMessage).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm halt' }))
    await waitFor(() => expect(control.halt).toHaveBeenCalledTimes(1))
  })

  it('/projects sends the expanded prompt', async () => {
    const { client } = await setup()
    await send('/projects')
    await waitFor(() => expect(client.sendMessage).toHaveBeenCalledWith(CONV.id, expect.objectContaining({ text: 'List my projects with their status.' })))
  })

  it('an argument command inserts its name, then sends with the argument', async () => {
    const { client } = await setup()
    type('/nod')
    expect(await options()).toEqual(['/nodes'])
    key('Enter')
    expect(box().value).toBe('/nodes ')
    expect(client.sendMessage).not.toHaveBeenCalled()
    await send('/nodes webterm')
    await waitFor(() => expect(client.sendMessage).toHaveBeenCalledWith(CONV.id, expect.objectContaining({ text: 'List the nodes in project webterm.' })))
  })

  it('an argument command without its argument shows the usage and keeps the command in the box', async () => {
    const { client } = await setup()
    await send('/plan')
    expect((await screen.findByRole('alert')).textContent).toContain('Usage: /plan <goal>')
    await waitFor(() => expect(box().value).toBe('/plan '))
    expect(client.sendMessage).not.toHaveBeenCalled()
  })

  it('/help opens the command list in the menu', async () => {
    const { client } = await setup()
    await send('/help')
    await waitFor(() => expect(box().value).toBe('/'))
    expect(await options()).toContain('/projects')
    expect(client.sendMessage).not.toHaveBeenCalled()
  })

  it('a skill sends a request to use it', async () => {
    const { client } = await setup()
    type('/')
    await waitFor(async () => expect(await options()).toContain('/webterm-demo'))
    await send('/webterm-demo for webterm')
    await waitFor(() => expect(client.sendMessage).toHaveBeenCalledWith(CONV.id, expect.objectContaining({ text: 'Use the "webterm-demo" skill. for webterm' })))
  })

  it('skills are absent when the route answers 503 skills_off', async () => {
    skills.list.mockRejectedValue(new InboxApiError('Skills are off', 503, 'skills_off'))
    await setup()
    type('/')
    const names = await options()
    expect(names).toContain('/approvals')
    expect(names).not.toContain('/webterm-demo')
  })

  it('without the Central panel, panel shortcuts and skills are not offered', async () => {
    await setup(false)
    type('/')
    const names = await options()
    expect(names).toContain('/projects')
    expect(names).not.toContain('/approvals')
    expect(names).not.toContain('/halt')
    expect(skills.list).not.toHaveBeenCalled()
  })

  it('"@" offers project names', async () => {
    await setup()
    type('show @web')
    const list = await screen.findByRole('listbox', { name: 'Projects' })
    await waitFor(() => expect(within(list).getAllByRole('option').map((o) => o.textContent)).toEqual(['@webtermproject']))
  })
})

describe('Central chat / commands with attachments', () => {
  // test-only fixture: a text file the composer queues as an attachment.
  const attach = async (): Promise<void> => {
    fireEvent(box(), createEvent.paste(box(), { clipboardData: { files: [new File(['ctx'], 'ctx.txt', { type: 'text/plain' })], items: [], getData: () => '' } }))
    await screen.findByText('ctx.txt')
  }

  it('a prompt shortcut sends the expanded prompt with the attachments', async () => {
    const { client } = await setup()
    await attach()
    await send('/projects')
    await waitFor(() => expect(client.sendMessage).toHaveBeenCalledTimes(1))
    const [, payload] = (client.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0] as [string, Record<string, unknown>]
    expect(payload['text']).toBe('List my projects with their status.')
    expect(payload['files']).toEqual([{ name: 'ctx.txt', data: btoa('ctx') }])
  })

  it('a UI-action command runs and sends nothing, attachments included', async () => {
    const { client } = await setup()
    await attach()
    await send('/history')
    expect(screen.getByRole('navigation', { name: 'Conversations' })).not.toBeNull()
    expect(client.sendMessage).not.toHaveBeenCalled()
  })
})
