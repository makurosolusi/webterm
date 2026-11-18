/** @vitest-environment jsdom */
// Downloads control of a browser node: badge and ring, the list in every state, keyboard and ARIA, and the actions
// against the REST routes (fetch is stubbed; the server side has its own tests).
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '../vscode/test-setup'
import type { DownloadItem } from '../../shared/browser.downloads'
import BrowserDownloads from './BrowserDownloads'
import { DL_TEXT } from './browserDownloads.text'

const item = (o: Partial<DownloadItem> & { id: string }): DownloadItem => ({
  nodeId: 'n1', name: `${o.id}.zip`, url: 'https://cdn.example/f', host: 'cdn.example', received: 0, total: 0, state: 'inProgress', risky: false, startedAt: 1, ...o,
})
const fetchMock = vi.fn()
const click = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }))
const open = (items: DownloadItem[]) => {
  render(<BrowserDownloads nodeId="n1" items={items} />)
  click(/^Downloads/)
}
const lastCall = () => fetchMock.mock.calls.at(-1) as [string, { method: string }]

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockResolvedValue(new Response(null, { status: 204 }))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('header button', () => {
  it('is a plain Downloads button when nothing is running', () => {
    render(<BrowserDownloads nodeId="n1" items={[item({ id: 'a', state: 'completed', received: 5, total: 5 })]} />)
    const b = screen.getByRole('button', { name: 'Downloads' })
    expect(b.getAttribute('aria-haspopup')).toBe('dialog')
    expect(b.getAttribute('aria-expanded')).toBe('false')
    expect(document.querySelector('.bdl-badge')).toBeNull()
    expect(document.querySelector('.bdl-ring')).toBeNull()
  })

  it('shows a count badge and a progress ring while files transfer, and names the count', () => {
    render(<BrowserDownloads nodeId="n1" items={[item({ id: 'a', received: 25, total: 100 }), item({ id: 'b', received: 75, total: 100 })]} />)
    expect(screen.getByRole('button', { name: DL_TEXT.buttonActive(2) })).toBeTruthy()
    expect(document.querySelector('.bdl-badge')?.textContent).toBe('2')
    const arc = document.querySelector('.bdl-ring-arc') as SVGCircleElement
    const full = Number(arc.getAttribute('stroke-dasharray'))
    expect(Number(arc.getAttribute('stroke-dashoffset'))).toBeCloseTo(full * 0.5, 3) // mean 50%
  })

  it('counts files waiting for Keep / Discard in the badge too', () => {
    render(<BrowserDownloads nodeId="n1" items={[item({ id: 'a', state: 'completed', pending: true })]} />)
    expect(screen.getByRole('button', { name: DL_TEXT.buttonPending(1) })).toBeTruthy()
    expect(document.querySelector('.bdl-badge')?.textContent).toBe('1')
  })
})

describe('popover', () => {
  it('is an accessible dialog: labelled, focused, linked from the button; Escape closes and returns focus', () => {
    render(<BrowserDownloads nodeId="n1" items={[]} />)
    const b = screen.getByRole('button', { name: 'Downloads' })
    fireEvent.click(b)
    const dialog = screen.getByRole('dialog', { name: 'Downloads' })
    expect(document.activeElement).toBe(dialog)
    expect(b.getAttribute('aria-expanded')).toBe('true')
    expect(b.getAttribute('aria-controls')).toBe(dialog.id)
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(b)
  })

  it('closes on a press outside but not on a press inside it or on its button', () => {
    render(<BrowserDownloads nodeId="n1" items={[]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Downloads' }))
    fireEvent.pointerDown(screen.getByRole('dialog'))
    expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('empty state says there are no downloads', () => {
    open([])
    expect(within(screen.getByRole('dialog')).getByText('No downloads yet')).toBeTruthy()
  })

  it('lists this node\'s downloads newest first and ignores other nodes', () => {
    open([item({ id: 'old', name: 'old.zip', state: 'completed', total: 5, received: 5 }), item({ id: 'new', name: 'new.zip', state: 'completed', total: 5, received: 5 }), item({ id: 'x', name: 'other.zip', nodeId: 'n2' })])
    const names = [...document.querySelectorAll('.bdl-filename')].map((e) => e.textContent)
    expect(names).toEqual(['new.zip', 'old.zip'])
  })

  it('a running download shows size, a progressbar with its value, and Cancel', () => {
    open([item({ id: 'a', name: 'big.iso', received: 50 * 1024 ** 2, total: 200 * 1024 ** 2 })])
    const bar = screen.getByRole('progressbar', { name: 'big.iso download progress' })
    expect(bar.getAttribute('aria-valuenow')).toBe('25')
    expect(screen.getByText(/cdn\.example · 50 MB of 200 MB/)).toBeTruthy()
    expect(screen.getByRole('button', { name: DL_TEXT.cancel })).toBeTruthy()
    expect(screen.queryByRole('button', { name: DL_TEXT.remove })).toBeNull()
  })

  it('an unknown size is an indeterminate bar with no fake percentage', () => {
    open([item({ id: 'a', received: 1024 })])
    const bar = screen.getByRole('progressbar')
    expect(bar.getAttribute('aria-valuenow')).toBeNull()
    expect(bar.getAttribute('aria-valuetext')).toBe(DL_TEXT.sizeUnknown)
  })

  it('a finished file offers Save a copy, Copy path and Remove', () => {
    open([item({ id: 'a', state: 'completed', received: 2048, total: 2048 })])
    for (const n of [DL_TEXT.saveCopy, DL_TEXT.copyPath, DL_TEXT.remove]) expect(screen.getByRole('button', { name: n })).toBeTruthy()
    expect(screen.queryByRole('progressbar')).toBeNull()
  })

  it('canceled, failed (with the reason) and missing are each worded', () => {
    open([
      item({ id: 'c', state: 'canceled' }),
      item({ id: 'f', state: 'failed', failure: 'disk_full' }),
      item({ id: 'q', state: 'failed', failure: 'too_large' }),
      item({ id: 'n', state: 'failed', failure: 'network' }),
      item({ id: 'm', state: 'missing', received: 3, total: 3 }),
    ])
    expect(screen.getByText('Canceled')).toBeTruthy()
    expect(screen.getByText('Failed: the disk is full')).toBeTruthy()
    expect(screen.getByText('Failed: the file is over the size limit')).toBeTruthy()
    expect(screen.getByText('Failed: the network connection was lost')).toBeTruthy()
    expect(screen.getByText(DL_TEXT.missing)).toBeTruthy()
  })

  it('an executable type carries a warning with its explanation', () => {
    open([item({ id: 'a', name: 'setup.pkg', state: 'completed', risky: true, received: 1, total: 1 })])
    const warn = screen.getByRole('img', { name: DL_TEXT.risky })
    expect(warn.getAttribute('tabindex')).toBe('0')
    expect(document.querySelector('[data-download="a"]')?.getAttribute('data-risky')).toBe('true')
  })
})

describe('actions', () => {
  it('Cancel posts to the cancel route', async () => {
    open([item({ id: 'g1', received: 1, total: 10 })])
    click(DL_TEXT.cancel)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(lastCall()[0]).toBe('/api/browser/n1/downloads/g1/cancel')
    expect(lastCall()[1].method).toBe('POST')
  })

  it('Remove deletes through the route and a refusal shows as an alert on the row', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'not_found' }), { status: 404 }))
    open([item({ id: 'g1', state: 'completed', received: 1, total: 1 })])
    click(DL_TEXT.remove)
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(lastCall()[0]).toBe('/api/browser/n1/downloads/g1')
    expect(lastCall()[1].method).toBe('DELETE')
    expect(screen.getByRole('alert').textContent).toContain('failed')
  })

  it('Copy path writes the server\'s path to the clipboard and says so', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ path: '/data/downloads/p/a.zip' }), { status: 200 }))
    open([item({ id: 'g1', state: 'completed', received: 1, total: 1 })])
    click(DL_TEXT.copyPath)
    await waitFor(() => expect(screen.getByText(DL_TEXT.copied)).toBeTruthy())
    expect(writeText).toHaveBeenCalledWith('/data/downloads/p/a.zip')
  })

  it('Save a copy opens the attachment URL through a temporary link (the browser picks the place), and sends no request itself', async () => {
    const clicks: Array<{ href: string; download: string }> = []
    const proto = HTMLAnchorElement.prototype
    const spy = vi.spyOn(proto, 'click').mockImplementation(function (this: HTMLAnchorElement) { clicks.push({ href: this.getAttribute('href') ?? '', download: this.download }) })
    open([item({ id: 'g1', name: 'a.zip', state: 'completed', received: 1, total: 1 })])
    click(DL_TEXT.saveCopy)
    await waitFor(() => expect(clicks).toHaveLength(1))
    expect(clicks[0]).toEqual({ href: '/api/browser/n1/downloads/g1/file', download: 'a.zip' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(screen.getByText(DL_TEXT.saveStarted)).toBeTruthy()
    spy.mockRestore()
  })

  it('"Ask before saving": a finished file waits with Keep and Discard (no Save a copy / Remove yet)', async () => {
    open([item({ id: 'g1', state: 'completed', received: 1, total: 1, pending: true })])
    const group = screen.getByRole('group', { name: DL_TEXT.askQuestion })
    expect(screen.queryByRole('button', { name: DL_TEXT.saveCopy })).toBeNull()
    fireEvent.click(within(group).getByRole('button', { name: DL_TEXT.keep }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(lastCall()[0]).toBe('/api/browser/n1/downloads/g1/keep')
    fireEvent.click(within(group).getByRole('button', { name: DL_TEXT.discard }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(lastCall()[1].method).toBe('DELETE')
  })
})

describe('updates', () => {
  it('re-renders the open list when the items change', () => {
    const { rerender } = render(<BrowserDownloads nodeId="n1" items={[item({ id: 'a', received: 10, total: 100 })]} />)
    click(/^Downloads/)
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('10')
    act(() => rerender(<BrowserDownloads nodeId="n1" items={[item({ id: 'a', received: 60, total: 100 })]} />))
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('60')
  })
})
