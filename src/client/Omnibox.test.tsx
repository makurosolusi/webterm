/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Omnibox from './Omnibox'
import { SEARCH_TEXT } from './Omnibox.data'
import { registerCommands, useCommandKeybindings } from './commandRegistry'
import { connectKeybindings, setKeybinding } from './keybindings.store'

type Call = { url: URL; init?: RequestInit }
let calls: Call[]
let respond: (u: URL) => Promise<unknown>

beforeEach(() => {
  calls = []
  vi.stubGlobal('fetch', vi.fn((input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://x')
    calls.push({ url, init })
    return new Promise((resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      void respond(url).then((body) => resolve({ ok: true, status: 200, json: async () => body }))
    })
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const sources = { nodes: [], commands: [], agents: [], recentUrls: [], asUrl: () => null }
const grepCalls = () => calls.filter((c) => c.url.pathname === '/api/fs/grep')
const cancelCalls = () => calls.filter((c) => c.url.pathname === '/api/fs/grep-cancel')
const page = (from: number, n: number, nextOffset: number | null, engine = 'rg') => ({
  ok: true, engine, cancelled: false, nextOffset,
  matches: Array.from({ length: n }, (_, i) => ({ file: `src/f${from + i}.ts`, line: from + i + 1, col: 3, text: `needle ${from + i}` })),
})

describe('Omnibox Find in Files (% mode)', () => {
  it('pages results with Load more, opens a match at its line, and shows the no-ripgrep notice', async () => {
    respond = async (u) => (u.searchParams.get('offset') === '0' ? page(0, 2, 2, 'fallback') : page(2, 1, null, 'fallback'))
    const onAction = vi.fn()
    render(<Omnibox scope="files" initialQuery="%needle" root="/w/p" sources={sources} onAction={onAction} onClose={() => {}} />)
    await screen.findByText('needle 0')
    expect(screen.getByText(SEARCH_TEXT.fallback)).not.toBeNull()
    const first = grepCalls()[0].url.searchParams
    expect([first.get('root'), first.get('q'), first.get('offset')]).toEqual(['/w/p', 'needle', '0'])

    fireEvent.click(screen.getByText('Load more results…'))
    await screen.findByText('needle 2')
    expect(grepCalls()[1].url.searchParams.get('offset')).toBe('2')
    expect(grepCalls()[1].url.searchParams.get('searchId')).toBe(first.get('searchId'))
    expect(screen.queryByText('Load more results…')).toBeNull()

    fireEvent.click(screen.getByText('needle 2'))
    expect(onAction).toHaveBeenCalledWith({ kind: 'file', rel: 'src/f2.ts', line: 3, col: 3 })
  })

  it('a new query cancels the in-flight search on both ends; closing does too', async () => {
    respond = () => new Promise(() => {}) // never answers: the search stays in flight
    const { unmount } = render(<Omnibox scope="files" initialQuery="%one" root="/w/p" sources={sources} onAction={() => {}} onClose={() => {}} />)
    await waitFor(() => expect(grepCalls().length).toBe(1))
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '%two' } })
    expect(grepCalls()[0].init?.signal?.aborted).toBe(true)
    expect(cancelCalls().length).toBe(1)
    await waitFor(() => expect(grepCalls().length).toBe(2))
    unmount()
    expect(grepCalls()[1].init?.signal?.aborted).toBe(true)
    expect(cancelCalls().length).toBe(2)
    expect(JSON.parse(String(cancelCalls()[1].init?.body))).toEqual({ searchId: grepCalls()[1].url.searchParams.get('searchId') })
  })
})

describe('Omnibox files (⌘P)', () => {
  it('lists the workspace files and opens the chosen one', async () => {
    respond = async () => ({ ok: true, files: ['src/a.ts', 'README.md'], truncated: false })
    const onAction = vi.fn()
    render(<Omnibox scope="files" root="/w/p" sources={sources} onAction={onAction} onClose={() => {}} />)
    await screen.findByText('README.md')
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'read' } })
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' })
    expect(onAction).toHaveBeenCalledWith({ kind: 'file', rel: 'README.md' })
  })
})

function Keys() { useCommandKeybindings(); return <textarea aria-label="term" /> }

describe('global keybindings', () => {
  beforeEach(() => { connectKeybindings({}, null) })

  it('runs the bound command (also from a text field when the chord has a modifier) and honours overrides', () => {
    const run = vi.fn()
    const off = registerCommands([{ id: 't.omni', label: 'Omni', defaultKey: 'Mod+K', run }])
    const outer = vi.fn()
    window.addEventListener('keydown', outer) // e.g. CanvasToolbar's old ⌘K listener
    render(<Keys />)
    fireEvent.keyDown(screen.getByLabelText('term'), { key: 'k', code: 'KeyK', ctrlKey: true })
    expect(run).toHaveBeenCalledTimes(1)
    expect(outer).not.toHaveBeenCalled()
    fireEvent.keyDown(screen.getByLabelText('term'), { key: 'k', code: 'KeyK' }) // plain key in a field: typing
    expect(run).toHaveBeenCalledTimes(1)
    setKeybinding('t.omni', 'Mod+J')
    fireEvent.keyDown(document.body, { key: 'k', code: 'KeyK', ctrlKey: true })
    fireEvent.keyDown(document.body, { key: 'j', code: 'KeyJ', ctrlKey: true })
    expect(run).toHaveBeenCalledTimes(2)
    window.removeEventListener('keydown', outer)
    off()
  })
})
