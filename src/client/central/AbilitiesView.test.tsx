/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { InboxApiError } from '../inboxTypes'
import AbilitiesView, { accessCounts, levelText } from './AbilitiesView'
import { fakeClient } from './centralFixtures.testutil'
import type { ToolRow } from './centralControlTypes'

afterEach(cleanup)

const kinds = () => [...document.querySelectorAll('[data-kind]')].map((g) => g.getAttribute('aria-label'))
const autoTool = (i: number): ToolRow => ({ name: `canvas.t${i}`, summary: `Tool number ${i}`, group: 'projects', tier: 'R0', on: true, access: 'auto' })

describe('AbilitiesView', () => {
  it('one summary line with level and counts; the longer explanation sits in the (i) popover', async () => {
    render(<AbilitiesView client={fakeClient()} />)
    expect((await screen.findByTestId('ability-summary')).textContent)
      .toBe('Level 2 — proposes work, you approve · 1 asks first · 2 not allowed · 2 on their own')
    expect(screen.queryByText('Everything Central can do at your current level.')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'About abilities' }))
    const pop = await screen.findByRole('dialog', { name: 'About abilities' })
    expect(within(pop).getByText('Everything Central can do at your current level.')).toBeTruthy()
    expect(within(pop).getByText(/nothing runs until you approve it/)).toBeTruthy()
  })

  it('groups by permission in order with counts; only exceptions carry a badge', async () => {
    render(<AbilitiesView client={fakeClient()} />)
    await screen.findByTestId('ability-summary')
    expect(kinds()).toEqual(['Asks you first', 'Not allowed', 'Runs on its own'])
    expect(screen.getByText('Asks you first (1)')).toBeTruthy()
    expect(screen.getByText('Not allowed (2)')).toBeTruthy()
    expect(screen.getByText('Runs on its own (2)')).toBeTruthy()
    const auto = screen.getByRole('group', { name: 'Runs on its own' })
    expect(within(auto).getByText('Projects & nodes (2)')).toBeTruthy()
    expect(auto.querySelectorAll('.ccp-badge')).toHaveLength(0)
    expect(screen.queryByText('Runs on its own', { selector: '.ccp-badge' })).toBeNull()
    expect(within(screen.getByRole('group', { name: 'Asks you first' })).getByText('Asks you first', { selector: '.ccp-badge' })).toBeTruthy()
    const blocked = screen.getByRole('group', { name: 'Not allowed' })
    expect(within(blocked).getByText('Not allowed at this level')).toBeTruthy()
    expect(within(blocked).getByText('Turned off')).toBeTruthy()
    expect(within(blocked).getByText('Browser (1)')).toBeTruthy()
    expect(await screen.findByText('webterm-demo')).toBeTruthy()
  })

  it('the internal id is not on the title line but is in the expanded details', async () => {
    render(<AbilitiesView client={fakeClient()} />)
    const title = await screen.findByText('List projects', { selector: 'strong' }) // plain label, not the model-facing summary
    const summary = title.closest('summary')!
    expect(summary.textContent).not.toContain('project.list')
    const id = screen.getByText('project.list', { selector: 'code' })
    expect(id.closest('.ccp-ab-row__more')).toBeTruthy()
    const row = summary.parentElement as HTMLDetailsElement
    expect(row.open).toBe(false)
    fireEvent.click(summary)
    expect(row.open).toBe(true)
    expect(row.contains(id)).toBe(true)
  })

  it('Change opens the exact Central level field in Settings', async () => {
    const seen: unknown[] = []
    const on = (e: Event): void => { seen.push((e as CustomEvent).detail) }
    window.addEventListener('webterm:open-settings', on)
    render(<AbilitiesView client={fakeClient()} />)
    await screen.findByTestId('ability-summary')
    fireEvent.click(screen.getByRole('button', { name: 'Change in Central settings' }))
    window.removeEventListener('webterm:open-settings', on)
    expect(seen).toEqual([{ section: 'central', field: 'central.level' }])
  })

  it('search filters by title, description and id, and the count follows', async () => {
    render(<AbilitiesView client={fakeClient()} />)
    expect((await screen.findByTestId('ability-count')).textContent).toBe('5 abilities')
    const box = screen.getByRole('searchbox', { name: 'Search abilities' })
    fireEvent.change(box, { target: { value: 'agent.spawn' } }) // id
    expect(screen.getByTestId('ability-count').textContent).toBe('1 of 5')
    expect(kinds()).toEqual(['Not allowed'])
    fireEvent.change(box, { target: { value: 'web page' } }) // server summary of an unknown tool
    expect(screen.getByText('browser.open', { selector: 'strong' })).toBeTruthy()
    fireEvent.change(box, { target: { value: 'List projects' } }) // title
    expect(screen.getByTestId('ability-count').textContent).toBe('1 of 5')
    fireEvent.change(box, { target: { value: 'zzz' } })
    expect(screen.getByText('Nothing matches this filter.')).toBeTruthy()
    expect(screen.getByTestId('ability-count').textContent).toBe('0 of 5')
  })

  it('with many tools the runs-on-its-own categories start collapsed, exceptions open; they toggle and open on search', async () => {
    const base = await fakeClient().listTools(new AbortController().signal)
    const listTools = vi.fn(async () => ({ ...base, tools: [...base.tools, ...Array.from({ length: 16 }, (_, i) => autoTool(i))] }))
    render(<AbilitiesView client={fakeClient({ listTools })} />)
    await screen.findByTestId('ability-summary')
    const cat = (kind: string, name: string) => within(screen.getByRole('group', { name: kind })).getByText(name, { selector: 'summary' }).parentElement as HTMLDetailsElement
    expect(cat('Runs on its own', 'Projects & nodes (18)').open).toBe(false)
    expect(cat('Asks you first', 'Tasks & plans (1)').open).toBe(true)
    fireEvent.click(within(screen.getByRole('group', { name: 'Runs on its own' })).getByText('Projects & nodes (18)'))
    expect(cat('Runs on its own', 'Projects & nodes (18)').open).toBe(true)
    fireEvent.click(within(screen.getByRole('group', { name: 'Runs on its own' })).getByText('Projects & nodes (18)'))
    expect(cat('Runs on its own', 'Projects & nodes (18)').open).toBe(false)
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'number 1' } })
    expect(cat('Runs on its own', 'Projects & nodes (7)').open).toBe(true)
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
    expect(screen.getByTestId('ability-summary').textContent).toBe('Level 0 — off')
    expect(screen.getAllByRole('button', { name: 'Change in Central settings' })).toHaveLength(1)
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

  it('the footnote opens Settings › Rules & secrets', async () => {
    const seen: unknown[] = []
    const on = (e: Event): void => { seen.push((e as CustomEvent).detail) }
    window.addEventListener('webterm:open-settings', on)
    render(<AbilitiesView client={fakeClient()} />)
    expect(await screen.findByText(/can still stop or pause a tool/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open Rules & secrets' }))
    window.removeEventListener('webterm:open-settings', on)
    expect(seen).toEqual([{ section: 'rules' }])
  })

  it('accessCounts leaves out kinds with no tool and folds turned off into not allowed; levelText reads plainly', () => {
    expect(accessCounts([])).toBe('')
    expect(accessCounts([{ name: 'a', summary: '', group: 'other', tier: 'R0', on: true, access: 'asks' }])).toBe('1 asks first')
    expect(levelText('L3 Starts workers, asks before risky steps')).toBe('Level 3 — starts workers, asks before risky steps')
  })
})
