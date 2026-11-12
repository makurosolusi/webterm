/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { InboxApiError } from '../inboxTypes'
import { knownTab } from './CentralControlPanel'
import MemoryView from './MemoryView'
import MemoryTab from './MemoryTab'
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
    expect((await screen.findByText('Central changed this; review and try again', { selector: '[data-action-result="failed"] span' }))).toBeTruthy()
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
    const save = screen.getByRole('button', { name: 'Save working state for All projects' })
    expect(save.getAttribute('aria-busy')).toBe('true')
    expect(save.textContent).toBe('Saving…')
    expect((await screen.findByText('This is too long to save. Shorten it and try again.', { selector: '[data-action-result="failed"] span' }))).toBeTruthy()
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
    const item = (await screen.findByText('one')).closest('li') as HTMLElement
    await waitFor(() => expect(item.querySelector('[data-action-result="failed"]')).toBeTruthy())
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
    expect(first.disabled).toBe(false)
  })
})

describe('Control › Memory: one surface, one filter bar', () => {
  // jsdom lacks the ResizeObserver / pointer-capture APIs the Radix popper menu calls when it opens.
  beforeAll(() => {
    globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
    Element.prototype.hasPointerCapture ??= () => false
    Element.prototype.scrollIntoView ??= () => undefined
  })
  // test-only
  const items = [
    { id: 'r1', kind: 'procedural', text: 'Rule one' }, { id: 'f1', kind: 'semantic', text: 'Fact one' }, { id: 'e1', kind: 'episodic', text: 'Session one' },
  ].map((m) => ({ scope: 'global', status: 'fact', trust: 'human', origin: 't', title: 't', suppressed: false, freshness: 1, needsReview: false, validFrom: 0, updatedAt: 0, ...m }))
  const stub = () => vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const kind = new URL(url, 'http://x').searchParams.get('kind')
    return new Response(JSON.stringify(
      url.startsWith('/api/memory2?') || url === '/api/memory2' ? { items: kind ? items.filter((m) => m.kind === kind) : items }
        : url === '/api/memory-proposals' ? { proposals: [{ id: 'p1', op: 'add', kind: 'preference', text: 'Proposed one', targetText: null, untrusted: false, node: null }], tokensToday: 0, dailyTokens: 0 }
          : url === '/api/blackboard' ? { entries: [{ id: 'b1', key: 'goal', value: 'Note one', status: 'set', by: 'human', at: 0 }], proposals: [] }
            : url.startsWith('/api/memory2/incognito') ? { refs: [] } : { facts: [] }))
  }))
  afterEach(() => vi.unstubAllGlobals())
  const trigger = (name: 'Source' | 'Kind') => screen.getByRole('button', { name: new RegExp(`^${name}: `) })
  const choose = (name: 'Source' | 'Kind', option: string) => {
    fireEvent.keyDown(trigger(name), { key: 'Enter' })
    fireEvent.click(screen.getByRole('menuitemradio', { name: option }))
  }
  const renderTab = (central = true) => {
    const client = fakeClient({ getWorkingState: vi.fn(async () => ({ global: null, project: null })), listMemory: list([]) })
    render(<MemoryTab client={client} central={central} />)
    return client
  }

  it('has no pill or tab rows, only the Source and Kind dropdowns under the Remember field', async () => {
    stub()
    renderTab()
    expect(await screen.findByText('Rule one')).toBeTruthy()
    const tab = screen.getByTestId('memory-tab')
    expect(within(tab).queryAllByRole('group')).toHaveLength(0)
    expect(within(tab).queryAllByRole('tablist')).toHaveLength(0)
    expect(tab.querySelectorAll('[aria-pressed]')).toHaveLength(0)
    expect(trigger('Source').textContent).toBe('Source: All')
    expect(trigger('Kind').textContent).toBe('Kind: All')
    const add = screen.getByRole('textbox', { name: 'Remember' })
    expect(add.compareDocumentPosition(screen.getByTestId('memory-filters')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('Kind=Rules shows only rules and the label says so', async () => {
    stub()
    renderTab()
    expect(await screen.findByText('Fact one')).toBeTruthy()
    choose('Kind', 'Rules')
    await waitFor(() => expect(screen.queryByText('Fact one')).toBeNull())
    expect(screen.getByText('Rule one')).toBeTruthy()
    expect(screen.queryByText('Session one')).toBeNull()
    expect(trigger('Kind').textContent).toBe('Kind: Rules')
  })

  it('Source=Suggested shows only suggested, keeps the bar and disables Kind', async () => {
    stub()
    renderTab()
    expect(await screen.findByTestId('memory-blackboard')).toBeTruthy()
    choose('Source', 'Suggested')
    expect(await screen.findByText('Proposed one')).toBeTruthy()
    expect(screen.queryByTestId('memory-all')).toBeNull()
    expect(screen.queryByTestId('memory-blackboard')).toBeNull()
    expect(screen.queryByText('Central has not remembered anything yet.')).toBeNull()
    expect(trigger('Source').textContent).toBe('Source: Suggested')
    expect((trigger('Kind') as HTMLButtonElement).disabled).toBe(true)
  })

  it('Notes and Central each show their part only', async () => {
    stub()
    renderTab()
    choose('Source', 'Notes')
    expect(await screen.findByTestId('memory-blackboard')).toBeTruthy()
    expect(screen.queryByTestId('memory-proposals')).toBeNull()
    choose('Source', 'Central')
    expect(await screen.findByText('Central has not remembered anything yet.')).toBeTruthy()
    expect(screen.queryByTestId('agent-memory')).toBeNull()
    expect(trigger('Source').textContent).toBe('Source: Central')
  })

  it('keyboard: Enter opens, arrows move, Enter chooses', async () => {
    stub()
    renderTab()
    expect(await screen.findByText('Session one')).toBeTruthy()
    fireEvent.keyDown(trigger('Kind'), { key: 'Enter' })
    const menu = screen.getByRole('menu', { name: /^Kind: / })
    expect(within(menu).getAllByRole('menuitemradio').map((o) => o.textContent)).toEqual(['All', 'Rules', 'Facts', 'Past sessions'])
    await waitFor(() => expect(document.activeElement?.textContent).toBe('All'))
    // Radix roving focus moves on a timer, so each arrow waits for focus to land.
    for (const next of ['Rules', 'Facts', 'Past sessions']) {
      fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
      await waitFor(() => expect(document.activeElement?.textContent).toBe(next))
    }
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' })
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    expect(trigger('Kind').textContent).toBe('Kind: Past sessions')
    await waitFor(() => expect(screen.queryByText('Rule one')).toBeNull())
    expect(screen.getByText('Session one')).toBeTruthy()
  })

  it('with Central off there is no Central source and Central is never asked', async () => {
    stub()
    const client = renderTab(false)
    expect(await screen.findByTestId('memory-all')).toBeTruthy()
    fireEvent.keyDown(trigger('Source'), { key: 'Enter' })
    expect(screen.getAllByRole('menuitemradio').map((o) => o.textContent)).toEqual(['All', 'Suggested', 'Notes'])
    expect(client.listMemory).not.toHaveBeenCalled()
  })
})
