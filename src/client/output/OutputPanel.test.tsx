/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OutputPanel } from './OutputPanel'
import { FakeEventSource, installFakeLogServer, makeEntry } from './outputTestKit'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const FILTER = (): HTMLInputElement => screen.getByLabelText('Filter output') as HTMLInputElement
const rows = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('.output-line'))
const texts = (): string[] => rows().map((row) => row.textContent ?? '')

async function mount(entries = [makeEntry(1), makeEntry(2)], props: { focusFilterToken?: number } = {}) {
  const server = installFakeLogServer(entries)
  const onClose = vi.fn()
  const view = render(<OutputPanel onClose={onClose} {...props} />)
  if (entries.length > 0) await waitFor(() => expect(rows().length).toBeGreaterThan(0))
  else await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1))
  return { server, onClose, ...view }
}

function scrollMetrics(el: HTMLElement, metrics: { scrollHeight: number; clientHeight: number; scrollTop: number }): void {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: metrics.scrollHeight })
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: metrics.clientHeight })
  el.scrollTop = metrics.scrollTop
}

describe('OutputPanel rendering', () => {
  it('renders `timestamp [level] [channel] message` with a class per level', async () => {
    await mount([
      makeEntry(1, { level: 'error', message: 'boom' }),
      makeEntry(2, { level: 'warn', channel: 'auth', message: 'careful' }),
      makeEntry(3, { level: 'debug' }),
    ])
    expect(texts()[0]).toBe('2026-11-02 21:26:23.124 [error] [pty] boom')
    expect(texts()[1]).toContain('[warning] [auth] careful')
    expect(rows()[0]!.querySelector('.output-line__level--error')).not.toBeNull()
    expect(rows()[1]!.querySelector('.output-line__level--warn')).not.toBeNull()
    expect(rows()[2]!.querySelector('.output-line__level--debug')).not.toBeNull()
    expect(rows()[0]!.querySelector('.output-line__ts')).not.toBeNull()
  })

  it('shows the empty states', async () => {
    await mount([])
    expect(screen.getByText('No log entries')).toBeTruthy()
    cleanup()
    await mount([makeEntry(1)])
    fireEvent.change(FILTER(), { target: { value: 'zzz' } })
    expect(screen.getByText('No results found with provided filter criteria.')).toBeTruthy()
  })

  it('appends streamed entries', async () => {
    await mount()
    act(() => FakeEventSource.last().send(makeEntry(3, { message: 'live' })))
    expect(texts().at(-1)).toContain('live')
  })
})

describe('OutputPanel toolbar', () => {
  it('lists All plus each channel with its count and filters by channel', async () => {
    await mount([makeEntry(1), makeEntry(2, { channel: 'auth', message: 'authmsg' }), makeEntry(3)])
    const select = screen.getByLabelText('Output channel') as HTMLSelectElement
    expect(Array.from(select.options).map((option) => option.textContent)).toEqual(['All', 'auth (1)', 'pty (2)'])
    fireEvent.change(select, { target: { value: 'auth' } })
    expect(texts()).toHaveLength(1)
    expect(texts()[0]).toContain('authmsg')
  })

  it('changing the level calls PUT /api/logs/level', async () => {
    const { server } = await mount()
    fireEvent.change(screen.getByLabelText('Log Level'), { target: { value: 'debug' } })
    await waitFor(() => expect(server.calls.at(-1)).toMatchObject({ method: 'PUT', url: '/api/logs/level', body: { level: 'debug' } }))
    await waitFor(() => expect((screen.getByLabelText('Log Level') as HTMLSelectElement).value).toBe('debug'))
  })

  it('Clear Output calls DELETE /api/logs and empties the panel', async () => {
    const { server } = await mount()
    fireEvent.click(screen.getByRole('button', { name: 'Clear Output' }))
    await waitFor(() => expect(rows()).toHaveLength(0))
    expect(server.calls.some((call) => call.method === 'DELETE' && call.url === '/api/logs')).toBe(true)
    expect(screen.getByText('No log entries')).toBeTruthy()
  })

  it('reports a failed clear instead of swallowing it', async () => {
    const { server } = await mount()
    server.failNext = true
    fireEvent.click(screen.getByRole('button', { name: 'Clear Output' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Could not clear the output')
    expect(rows()).toHaveLength(2)
  })

  it('Close Panel calls onClose', async () => {
    const { onClose } = await mount()
    fireEvent.click(screen.getByRole('button', { name: 'Close Panel' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('Copy All writes the visible lines to the clipboard', async () => {
    const writeText = vi.fn(async () => undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    await mount([makeEntry(1, { ids: { nodeId: 'node-abc' } }), makeEntry(2, { message: 'other' })])
    fireEvent.change(FILTER(), { target: { value: 'node-abc' } })
    fireEvent.click(screen.getByRole('button', { name: 'Copy All' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
    expect(writeText).toHaveBeenCalledWith('2026-11-02 21:26:23.124 [info] [pty] message 1 nodeId=node-abc')
  })

  it('Save As downloads a .log file', async () => {
    const createObjectURL = vi.fn(() => 'blob:x')
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    await mount()
    fireEvent.click(screen.getByRole('button', { name: 'Save As...' }))
    await waitFor(() => expect(click).toHaveBeenCalledTimes(1))
    expect(createObjectURL).toHaveBeenCalledTimes(1)
  })
})

describe('OutputPanel filter', () => {
  const sample = [
    makeEntry(1, { message: 'alpha one' }), makeEntry(2, { message: 'beta two' }),
    makeEntry(3, { message: 'alpha noisy' }),
  ]

  it('supports text, !exclude and comma terms', async () => {
    await mount(sample)
    fireEvent.change(FILTER(), { target: { value: 'alpha' } })
    expect(texts()).toHaveLength(2)
    fireEvent.change(FILTER(), { target: { value: 'alpha, !noisy' } })
    expect(texts()).toHaveLength(1)
    expect(texts()[0]).toContain('alpha one')
    fireEvent.change(FILTER(), { target: { value: 'beta, one' } })
    expect(texts()).toHaveLength(2)
  })

  it('Escape clears the filter', async () => {
    await mount(sample)
    fireEvent.change(FILTER(), { target: { value: 'beta' } })
    fireEvent.keyDown(FILTER(), { key: 'Escape' })
    expect(FILTER().value).toBe('')
    expect(texts()).toHaveLength(3)
  })

  it('clicking an id chip fills the filter with that id', async () => {
    await mount([makeEntry(1, { ids: { nodeId: 'node-abcdef123' } }), makeEntry(2)])
    fireEvent.click(screen.getByRole('button', { name: 'Filter by nodeId node-abcdef123' }))
    expect(FILTER().value).toBe('node-abcdef123')
    expect(texts()).toHaveLength(1)
  })

  it('Ctrl/Cmd+F focuses the filter box', async () => {
    await mount()
    const log = screen.getByRole('log')
    log.focus()
    fireEvent.keyDown(log, { key: 'f', ctrlKey: true })
    expect(document.activeElement).toBe(FILTER())
    log.focus()
    fireEvent.keyDown(log, { key: 'f', metaKey: true })
    expect(document.activeElement).toBe(FILTER())
  })

  it('focusFilterToken moves focus to the filter on change', async () => {
    const { rerender, onClose } = await mount(undefined, { focusFilterToken: 0 })
    screen.getByRole('log').focus()
    rerender(<OutputPanel onClose={onClose} focusFilterToken={1} />)
    expect(document.activeElement).toBe(FILTER())
  })
})

describe('OutputPanel auto-scroll', () => {
  it('locks when the user scrolls up, unlocks at the bottom, and mirrors that on the button', async () => {
    await mount()
    const log = screen.getByRole('log')
    const button = () => screen.getByRole('button', { name: /Turn Auto Scrolling/ })
    expect(button().getAttribute('aria-label')).toBe('Turn Auto Scrolling Off')
    expect(button().getAttribute('aria-pressed')).toBe('false')

    scrollMetrics(log, { scrollHeight: 1000, clientHeight: 100, scrollTop: 0 })
    fireEvent.scroll(log)
    expect(button().getAttribute('aria-label')).toBe('Turn Auto Scrolling On')
    expect(button().getAttribute('aria-pressed')).toBe('true')

    act(() => FakeEventSource.last().send(makeEntry(3)))
    expect(log.scrollTop).toBe(0)

    scrollMetrics(log, { scrollHeight: 1000, clientHeight: 100, scrollTop: 900 })
    fireEvent.scroll(log)
    expect(button().getAttribute('aria-label')).toBe('Turn Auto Scrolling Off')
  })

  it('pins to the bottom on new entries while on, and the button toggles it', async () => {
    await mount()
    const log = screen.getByRole('log')
    scrollMetrics(log, { scrollHeight: 500, clientHeight: 100, scrollTop: 400 })
    act(() => FakeEventSource.last().send(makeEntry(3)))
    expect(log.scrollTop).toBe(500)

    fireEvent.click(screen.getByRole('button', { name: 'Turn Auto Scrolling Off' }))
    log.scrollTop = 10
    act(() => FakeEventSource.last().send(makeEntry(4)))
    expect(log.scrollTop).toBe(10)

    fireEvent.click(screen.getByRole('button', { name: 'Turn Auto Scrolling On' }))
    expect(log.scrollTop).toBe(500)
  })
})

describe('OutputPanel accessibility', () => {
  it('exposes a non-announcing log, a labelled toolbar and named controls', async () => {
    await mount()
    const log = screen.getByRole('log')
    expect(log.getAttribute('aria-live')).toBe('off')
    const toolbar = screen.getByRole('toolbar', { name: 'Output actions' })
    for (const name of ['Clear Output', 'Copy All', 'Save As...', 'Close Panel']) {
      expect(within(toolbar).getByRole('button', { name })).toBeTruthy()
    }
    expect(screen.getByLabelText('Output channel')).toBeTruthy()
    expect(screen.getByLabelText('Log Level')).toBeTruthy()
    expect(FILTER().placeholder).toBe('Filter (e.g. text, !exclude, \\escape)')
  })
})
