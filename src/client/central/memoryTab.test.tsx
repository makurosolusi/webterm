/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { InboxApiError } from '../inboxTypes'
import { knownTab } from './CentralControlPanel'
import MemoryView from './MemoryView'
import { CENTRAL_PAGE_SIZE } from './centralControlApi'
import type { MemoryRow } from './centralControlTypes'
import { fakeClient } from './centralFixtures.testutil'

afterEach(cleanup)

// test-only
const row = (over: Partial<MemoryRow> = {}): MemoryRow => ({ id: 'm1', scope: 'central', trust: 'agent', kind: 'procedure', key: 'k1', value: 'always test', status: 'claim', sourceKind: 'consolidator', sourceRef: null, createdAt: Date.now(), projectName: 'Webterm', ...over })
const list = (rows: MemoryRow[]) => vi.fn(async () => rows)

describe('Memory tab states', () => {
  it('is a known tab', () => {
    expect(knownTab('memory')).toBe('memory')
    expect(knownTab('approvals')).toBe('status')
  })

  it('shows loading before data', () => {
    const pending = () => new Promise<never>(() => undefined)
    render(<MemoryView client={fakeClient({ getWorkingState: vi.fn(pending), listMemory: vi.fn(pending) })} />)
    expect(screen.getAllByRole('status').map((s) => s.textContent)).toEqual(['Loading…', 'Loading…'])
  })

  it('says when nothing is saved or remembered', async () => {
    render(<MemoryView client={fakeClient({ getWorkingState: vi.fn(async () => ({ global: null, project: null })), listMemory: list([]) })} />)
    expect(await screen.findByText('Central has not written anything here yet.')).toBeTruthy()
    expect(await screen.findByText('Central has not remembered anything yet.')).toBeTruthy()
  })

  it('shows an error per section, in words', async () => {
    const boom = new InboxApiError('GET failed (500 internal_error)', 500, 'internal_error')
    render(<MemoryView client={fakeClient({ getWorkingState: vi.fn(async () => { throw boom }), listMemory: vi.fn(async () => { throw boom }) })} />)
    await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(2))
    expect(screen.queryByText(/internal_error/)).toBeNull()
  })

  it.each(['central_off', 'http_404'])('shows the off state for %s, not an error', async (code) => {
    render(<MemoryView client={fakeClient({ getWorkingState: vi.fn(async () => { throw new InboxApiError('off', 503, code) }) })} />)
    expect(await screen.findByText(/Central is off/)).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('button', { name: 'Open Central settings' })).toBeTruthy()
  })

  it('offers Load more on a full page and asks for the next offset', async () => {
    const page = Array.from({ length: CENTRAL_PAGE_SIZE }, (_, i) => row({ id: `m${i}`, key: `k${i}` }))
    const listMemory = list(page)
    render(<MemoryView client={fakeClient({ listMemory })} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }))
    await waitFor(() => expect(listMemory).toHaveBeenLastCalledWith(CENTRAL_PAGE_SIZE, expect.anything(), {}))
  })
})

describe('Working state', () => {
  const edit = async () => {
    fireEvent.click(await screen.findByRole('button', { name: 'Edit working state for All projects' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Working state for All projects' }), { target: { value: 'mine' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save working state for All projects' }))
  }

  it('reads first and shows version, author and time', async () => {
    render(<MemoryView client={fakeClient()} />)
    expect(await screen.findByText('global notes')).toBeTruthy()
    expect(screen.getByText(/Version 3 · Updated by central/)).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('saves with the version it read and closes the editor', async () => {
    const client = fakeClient()
    render(<MemoryView client={client} />)
    await edit()
    await waitFor(() => expect(client.saveWorkingState).toHaveBeenCalledWith(null, 'mine', 3))
    await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull())
    await waitFor(() => expect(client.getWorkingState).toHaveBeenCalledTimes(2))
  })

  it('on a conflict says so, reloads, keeps the draft and saves against the fresh version', async () => {
    let version = 3
    const client = fakeClient({
      getWorkingState: vi.fn(async () => ({ global: { body: `v${version}`, version, updatedAt: 1, updatedBy: 'central' }, project: null })),
      saveWorkingState: vi.fn().mockImplementationOnce(async () => { version = 4; throw new InboxApiError('conflict', 409, 'version_conflict') }).mockResolvedValue(undefined),
    })
    render(<MemoryView client={client} />)
    await edit()
    expect((await screen.findByRole('alert')).textContent).toBe('Central changed this; review and try again')
    expect(await screen.findByText('v4')).toBeTruthy()
    expect((screen.getByRole('textbox', { name: 'Working state for All projects' }) as HTMLTextAreaElement).value).toBe('mine')
    fireEvent.click(screen.getByRole('button', { name: 'Save working state for All projects' }))
    await waitFor(() => expect(client.saveWorkingState).toHaveBeenLastCalledWith(null, 'mine', 4))
  })
})

describe('Working state save errors', () => {
  it('says plainly when the text is too long and keeps the editor open', async () => {
    const client = fakeClient({ saveWorkingState: vi.fn(async () => { throw new InboxApiError('big', 400, 'state_too_large') }) })
    render(<MemoryView client={client} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Edit working state for All projects' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save working state for All projects' }))
    expect((await screen.findByRole('alert')).textContent).toBe('This is too long to save. Shorten it and try again.')
    expect(screen.getByRole('textbox')).toBeTruthy()
  })

  it('names you as the author of your own edit', async () => {
    render(<MemoryView client={fakeClient({ getWorkingState: vi.fn(async () => ({ global: { body: 'x', version: 1, updatedAt: 1, updatedBy: 'human:root' }, project: null })) })} />)
    expect(await screen.findByText(/Updated by you/)).toBeTruthy()
  })
})

describe('Remembered rows', () => {
  const twoRows = [row({ id: 'a', key: 'first', value: 'one' }), row({ id: 'b', key: 'second', value: 'two' })]

  it('shows kind, plain trust, source, linked task and project', async () => {
    render(<MemoryView client={fakeClient({ listMemory: list([row({ sourceKind: 'task', sourceRef: 't-9' })]) })} />)
    const item = (await screen.findByText('always test')).closest('li') as HTMLElement
    expect(within(item).getByText('From an agent, unverified')).toBeTruthy()
    expect(within(item).getByText(/procedure · Webterm · From a task · Task t-9 · just now/)).toBeTruthy()
  })

  it('offers Confirm on every claim that is not external, including one Central remembered', async () => {
    render(<MemoryView client={fakeClient({ listMemory: list([
      row({ id: 'a', key: 'remembered', sourceKind: 'central' }),
      row({ id: 'b', key: 'web', trust: 'external' }),
      row({ id: 'c', key: 'known', status: 'fact', trust: 'human' }),
    ]) })} />)
    expect(await screen.findByRole('button', { name: 'Confirm memory: remembered' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Confirm memory: web' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Confirm memory: known' })).toBeNull()
  })

  it('confirm shows in flight on that row only, then the row reads as confirmed', async () => {
    let finish = (): void => undefined
    const confirmMemory = vi.fn(() => new Promise<void>((r) => { finish = r }))
    render(<MemoryView client={fakeClient({ listMemory: list(twoRows), confirmMemory })} />)
    const first = await screen.findByRole('button', { name: 'Confirm memory: first' }) as HTMLButtonElement
    fireEvent.click(first)
    await waitFor(() => expect(first.disabled).toBe(true))
    expect((screen.getByRole('button', { name: 'Confirm memory: second' }) as HTMLButtonElement).disabled).toBe(false)
    expect(confirmMemory).toHaveBeenCalledWith('a')
    finish()
    expect(await screen.findByText('Confirmed by you')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Confirm memory: first' })).toBeNull()
  })

  it('forget asks once; Keep backs out, Yes forgets that row only', async () => {
    const client = fakeClient({ listMemory: list(twoRows) })
    render(<MemoryView client={client} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Forget memory: first' }))
    expect(client.forgetMemory).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Forget memory: first' }))
    fireEvent.click(screen.getByRole('button', { name: 'Yes, forget' }))
    await waitFor(() => expect(client.forgetMemory).toHaveBeenCalledWith('a'))
    await waitFor(() => expect(screen.queryByText('one')).toBeNull())
    expect(screen.getByText('two')).toBeTruthy()
  })

  it('a failed action shows on its row and frees it', async () => {
    const confirmMemory = vi.fn(async () => { throw new InboxApiError('nope', 400, 'untrusted_source') })
    render(<MemoryView client={fakeClient({ listMemory: list(twoRows), confirmMemory })} />)
    const first = await screen.findByRole('button', { name: 'Confirm memory: first' }) as HTMLButtonElement
    fireEvent.click(first)
    const alert = await screen.findByRole('alert')
    expect(alert.closest('li')?.textContent).toContain('one')
    expect(first.disabled).toBe(false)
  })
})
