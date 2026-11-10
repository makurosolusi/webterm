/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { InboxApiError } from '../inboxTypes'
import AbilitiesView, { accessCounts } from './AbilitiesView'
import { fakeClient } from './centralFixtures.testutil'

afterEach(cleanup)

describe('AbilitiesView', () => {
  it('counts, groups and badges every tool, then lists the skills Central can use', async () => {
    render(<AbilitiesView client={fakeClient()} />)
    expect((await screen.findByTestId('ability-counts')).textContent).toBe('2 run on their own · 1 asks you first · 1 not allowed at this level · 1 turned off')
    const projects = screen.getByRole('group', { name: 'Projects & nodes' })
    expect(within(projects).getByText('Projects & nodes (2)')).toBeTruthy()
    expect(within(projects).getByText('project.list')).toBeTruthy()
    expect(within(projects).getByText('List projects')).toBeTruthy() // plain label, not the model-facing summary
    expect(within(screen.getByRole('group', { name: 'Browser' })).getByText('browser.open', { selector: 'strong' })).toBeTruthy() // unknown tool: name + server summary
    expect(screen.getByText('Open a web page')).toBeTruthy()
    expect(within(projects).getAllByText('Runs on its own')).toHaveLength(2)
    expect(within(screen.getByRole('group', { name: 'Tasks & plans' })).getByText('Asks you first')).toBeTruthy()
    expect(within(screen.getByRole('group', { name: 'Workers' })).getByText('Not allowed at this level')).toBeTruthy()
    expect(within(screen.getByRole('group', { name: 'Browser' })).getByText('Turned off')).toBeTruthy()
    expect(await screen.findByText('webterm-demo')).toBeTruthy()
    expect(screen.getByText('Summarize project status')).toBeTruthy()
  })

  it('the filter shows one kind; Not allowed also covers tools that are turned off', async () => {
    render(<AbilitiesView client={fakeClient()} />)
    await screen.findByTestId('ability-counts')
    fireEvent.click(screen.getByRole('radio', { name: 'Asks you' }))
    expect(screen.getByText('Plan tasks')).toBeTruthy()
    expect(screen.queryByText('List projects')).toBeNull()
    fireEvent.click(screen.getByRole('radio', { name: 'Not allowed' }))
    expect(screen.getByText('Start a worker')).toBeTruthy()
    expect(screen.getByText('Open a web page')).toBeTruthy()
    expect(screen.queryByText('Plan tasks')).toBeNull()
  })

  it('a failed load is a plain error with Refresh that loads again', async () => {
    const listTools = vi.fn().mockRejectedValueOnce(new InboxApiError('GET /api/central/tools failed (500 x)', 500, 'x'))
      .mockResolvedValue({ level: 'observe', tools: [] })
    render(<AbilitiesView client={fakeClient({ listTools })} />)
    expect((await screen.findByRole('alert')).textContent).toBe('Could not load this section. Use Refresh to try again.')
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(await screen.findByText('Central has no tools yet.')).toBeTruthy()
    expect(listTools).toHaveBeenCalledTimes(2)
  })

  it('Central at level off says so and offers Change; skills off and no skills read plainly', async () => {
    const client = fakeClient({
      listTools: vi.fn(async () => ({ level: 'off' as const, tools: [] })),
      listActiveSkills: vi.fn().mockRejectedValue(new InboxApiError('x', 503, 'skills_off')),
    })
    render(<AbilitiesView client={client} />)
    expect(await screen.findByText(/Central is turned off/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Change in Central settings' })).toBeTruthy()
    expect(await screen.findByText('Skills are turned off. Turn them on in the Skills tab.')).toBeTruthy()
    cleanup()
    render(<AbilitiesView client={fakeClient({ listActiveSkills: vi.fn(async () => []) })} />)
    await waitFor(() => expect(screen.getByText(/No skills yet/)).toBeTruthy())
  })

  it('Central fully off (every /api/central path is 404) shows the off state, not an error, and no skills block', async () => {
    const gone = () => Promise.reject(new InboxApiError('GET /api/central/tools failed (404 not_found)', 404, 'not_found'))
    const client = fakeClient({ listTools: vi.fn(gone), listActiveSkills: vi.fn(gone) })
    render(<AbilitiesView client={client} />)
    expect(await screen.findByText(/Central is turned off/)).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByText('Skills Central can use')).toBeNull()
    expect(client.listActiveSkills).not.toHaveBeenCalled()
  })

  it('the footnote opens Settings › Rules & approvals', async () => {
    const seen: unknown[] = []
    const on = (e: Event): void => { seen.push((e as CustomEvent).detail) }
    window.addEventListener('webterm:open-settings', on)
    render(<AbilitiesView client={fakeClient()} />)
    expect(await screen.findByText(/can still stop or pause a tool/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open Rules & approvals' }))
    window.removeEventListener('webterm:open-settings', on)
    expect(seen).toEqual([{ section: 'rules' }])
  })

  it('accessCounts leaves out kinds with no tool', () => {
    expect(accessCounts([])).toBe('')
    expect(accessCounts([{ name: 'a', summary: '', group: 'other', tier: 'R0', on: true, access: 'asks' }])).toBe('1 asks you first')
  })
})
