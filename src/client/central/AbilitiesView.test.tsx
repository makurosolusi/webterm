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
    expect(screen.getByText('Propose a plan for you to approve')).toBeTruthy()
    expect(screen.queryByText('List your projects and their status')).toBeNull()
    fireEvent.click(screen.getByRole('radio', { name: 'Not allowed' }))
    expect(screen.getByText('Start a worker')).toBeTruthy()
    expect(screen.getByText('Open a web page')).toBeTruthy()
    expect(screen.queryByText('Propose a plan for you to approve')).toBeNull()
  })

  it('a failed load is a plain error with Refresh that loads again', async () => {
    const listTools = vi.fn().mockRejectedValueOnce(new InboxApiError('GET /api/central/tools failed (404 x)', 404, 'x'))
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

  it('accessCounts leaves out kinds with no tool', () => {
    expect(accessCounts([])).toBe('')
    expect(accessCounts([{ name: 'a', summary: '', group: 'other', tier: 'R0', on: true, access: 'asks' }])).toBe('1 asks you first')
  })
})
