/** @vitest-environment jsdom */
// Health tab list: status tabs, severity toggles, the Filter select, grouped one-line rows and their actions.
import { cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { CENTRAL_PAGE_SIZE } from '../centralControlApi'
import { shimRadixSelect } from '../work/taskBoardFixtures.testutil'
import { setLspFileOpener } from '../../editorLsp.store'
import { useCentralChatDraft, useSideBar } from '../../secondarySideBar.store'
import HealthView from './HealthView'
import { expand, findingOf, makeClient, summaryOf } from './health.fixtures.testutil'
import { HL, fixRequest } from './healthModel'

beforeAll(shimRadixSelect)
beforeEach(() => localStorage.clear())
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const pickFilter = async (option: string) => {
  fireEvent.keyDown(screen.getByRole('combobox', { name: HL.filter }), { key: 'Enter' })
  fireEvent.click(await screen.findByRole('option', { name: option }))
}

describe('Health filters, dismiss and pages', () => {
  it('status is tabs with counts, not pill rows; a tab changes the query', async () => {
    const client = makeClient()
    render(<HealthView client={client} />)
    await expand()
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent)
    expect(tabs).toEqual(['Open1', 'Dismissed0', 'Fixed2'])
    expect(client.countFindings).toHaveBeenCalledWith('p1', 'dismissed', expect.anything())
    expect(screen.queryByRole('group', { name: HL.statusLabel })).toBeNull()
    expect(screen.queryByRole('group', { name: HL.originLabel })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Any' })).toBeNull()
    fireEvent.mouseDown(screen.getByRole('tab', { name: /^Dismissed/ }))
    await waitFor(() => expect(client.listFindings).toHaveBeenLastCalledWith('p1', { status: 'dismissed' }, { limit: CENTRAL_PAGE_SIZE, offset: 0 }, expect.anything()))
    expect(screen.getByRole('tab', { name: /^Dismissed/ }).getAttribute('aria-selected')).toBe('true')
  })

  it('severity chips are toggle filters with open counts', async () => {
    const client = makeClient({ getSummary: vi.fn(async () => summaryOf({ open: 7, high: 0, low: 7 })) })
    render(<HealthView client={client} />)
    await expand()
    const severity = screen.getByRole('group', { name: HL.severityLabel })
    const low = within(severity).getByRole('button', { name: 'Low 7' })
    expect(within(severity).getByRole('button', { name: 'High 0' }).getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(low)
    await waitFor(() => expect(client.listFindings).toHaveBeenLastCalledWith('p1', { status: 'open', severity: 'low' }, expect.anything(), expect.anything()))
    expect(within(screen.getByRole('group', { name: HL.severityLabel })).getByRole('button', { name: 'Low 7' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(within(screen.getByRole('group', { name: HL.severityLabel })).getByRole('button', { name: 'Low 7' }))
    await waitFor(() => expect(client.listFindings).toHaveBeenLastCalledWith('p1', { status: 'open' }, expect.anything(), expect.anything()))
  })

  it('one Filter select narrows by rule or by source, one at a time', async () => {
    const client = makeClient()
    render(<HealthView client={client} />)
    await expand()
    await pickFilter('Empty catch')
    await waitFor(() => expect(client.listFindings).toHaveBeenLastCalledWith('p1', { status: 'open', rule: 'empty_catch' }, expect.anything(), expect.anything()))
    await pickFilter('Analysis')
    await waitFor(() => expect(client.listFindings).toHaveBeenLastCalledWith('p1', { status: 'open', origin: 'analysis' }, expect.anything(), expect.anything()))
  })

  it('groups findings of one kind with a count; children show file and locale-formatted metrics', async () => {
    const big = (id: string, file: string) => findingOf({ id, file, line: null, title: 'File is approaching the size limit', severity: 'low', evidence: '480 lines, 13 360 chars (limit 500 lines / 20 000 chars)' })
    const items = [big('a', 'src/a.ts'), findingOf({ id: 'x', rule: 'empty_catch', title: 'Empty catch' }), big('b', 'src/deep/b.ts')]
    render(<HealthView client={makeClient({ listFindings: vi.fn(async () => ({ items, hasMore: false })) })} />)
    const group = await screen.findByRole('button', { name: HL.group('File is approaching the size limit', 2) })
    expect(screen.getByRole('button', { name: HL.details('Empty catch') })).toBeTruthy()
    expect(group.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('button', { name: 'a.ts' })).toBeNull()
    fireEvent.click(group)
    expect(screen.getByRole('button', { name: 'a.ts' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'b.ts' })).toBeTruthy()
    expect(screen.getAllByText('480 lines, 13,360 chars (limit 500 lines / 20,000 chars)')).toHaveLength(2)
  })

  it('the file opens in an editor at the finding line; actions include Copy path, Ask Central to fix and Dismiss', async () => {
    const opener = vi.fn()
    const unregister = setLspFileOpener(opener)
    try {
      render(<HealthView client={makeClient()} />)
      fireEvent.click(await screen.findByRole('button', { name: 'big.ts:12' }))
      expect(opener).toHaveBeenCalledWith('/repo/src/big.ts', 12, 0)
      const actions = screen.getByRole('group', { name: HL.actionsLabel('File too large') })
      fireEvent.click(within(actions).getByRole('button', { name: HL.openFile }))
      expect(opener).toHaveBeenCalledTimes(2)
      expect(within(actions).getByRole('button', { name: HL.copy })).toBeTruthy()
      expect(within(actions).getByRole('button', { name: HL.dismissLabel('File too large') })).toBeTruthy()
      const draft = renderHook(() => ({ draft: useCentralChatDraft(), bar: useSideBar() }))
      fireEvent.click(within(actions).getByRole('button', { name: HL.askFix }))
      expect(draft.result.current.draft?.text).toBe(fixRequest('Alpha', findingOf()))
      expect(draft.result.current.bar).toMatchObject({ open: true, view: 'chat' })
    } finally { unregister() }
  })

  it('Open file is off when the project folder is unknown', async () => {
    const unregister = setLspFileOpener(vi.fn())
    try {
      render(<HealthView client={makeClient({ listProjects: vi.fn(async () => [{ id: 'p1', name: 'Alpha' }]) })} />)
      expect(((await screen.findByRole('button', { name: 'big.ts:12' })) as HTMLButtonElement).disabled).toBe(true)
    } finally { unregister() }
  })

  it('dismiss needs a reason and sends preset plus note', async () => {
    const client = makeClient()
    render(<HealthView client={client} />)
    fireEvent.click(await screen.findByRole('button', { name: HL.dismissLabel('File too large') }))
    const form = screen.getByRole('group', { name: HL.dismissLabel('File too large') })
    const confirm = within(form).getByRole('button', { name: HL.dismissConfirm })
    expect((confirm as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(within(form).getByRole('button', { name: 'False positive' }))
    fireEvent.change(within(form).getByRole('textbox', { name: HL.dismissNote }), { target: { value: 'generated file' } })
    fireEvent.click(confirm)
    expect(confirm.getAttribute('aria-busy')).toBe('true')
    expect(confirm.textContent).toBe('Dismissing…')
    await waitFor(() => expect(client.dismiss).toHaveBeenCalledWith('f1', 'False positive: generated file'))
    const reopen = await screen.findByRole('button', { name: HL.reopenLabel('File too large') }) as HTMLButtonElement
    await expand()
    expect(screen.getByText('Dismissed: False positive: generated file')).toBeTruthy()
    await waitFor(() => expect(client.countFindings.mock.calls.length).toBeGreaterThan(2))
    await waitFor(() => expect(reopen.disabled).toBe(false))
    fireEvent.click(reopen)
    await waitFor(() => expect(client.reopen).toHaveBeenCalledWith('f1'))
  })

  it('offers Load more on a full page and asks for the next offset', async () => {
    const items = Array.from({ length: CENTRAL_PAGE_SIZE }, (_, i) => findingOf({ id: `f${i}`, title: `Finding ${i}` }))
    const client = makeClient({ listFindings: vi.fn(async () => ({ items, hasMore: true })) })
    render(<HealthView client={client} />)
    fireEvent.click(await screen.findByRole('button', { name: HL.loadMore }))
    await waitFor(() => expect(client.listFindings).toHaveBeenLastCalledWith('p1', { status: 'open' }, { limit: CENTRAL_PAGE_SIZE, offset: CENTRAL_PAGE_SIZE }, expect.anything()))
  })
})
