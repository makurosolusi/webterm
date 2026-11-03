/** @vitest-environment jsdom */
// Dialog Quick Open: daftar sekali per pembukaan, fuzzy lokal, ↑/↓/Enter/Esc, galat & potongan.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fs = vi.hoisted(() => ({ search: vi.fn() }))
vi.mock('./fsClient', () => fs)

import QuickOpen, { QUICK_OPEN_MATCH_ALL, QUICK_TEXT } from './QuickOpen'

const FILES = ['README.md', 'src/app.ts', 'src/a/p/xp.ts', 'src/utils/helper-app.ts']
const options = () => screen.getAllByRole('option').map((o) => o.textContent)
const setup = () => {
  const onOpen = vi.fn()
  const onClose = vi.fn()
  render(<QuickOpen root="/proj" onOpen={onOpen} onClose={onClose} />)
  return { onOpen, onClose, input: () => screen.getByRole('combobox') }
}

beforeEach(() => { fs.search.mockResolvedValue({ ok: true, files: FILES, truncated: false }) })
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('QuickOpen', () => {
  it('requests the full list once per opening and shows it', async () => {
    const { input } = setup()
    await waitFor(() => expect(options()).toEqual(FILES))
    fireEvent.change(input(), { target: { value: 'app' } })
    fireEvent.change(input(), { target: { value: 'appt' } })
    expect(fs.search).toHaveBeenCalledTimes(1)
    expect(fs.search).toHaveBeenCalledWith('/proj', QUICK_OPEN_MATCH_ALL)
  })

  it('filters fuzzy and ranks the best match first; no match shows the empty message', async () => {
    const { input } = setup()
    await waitFor(() => expect(options()).toHaveLength(FILES.length))
    fireEvent.change(input(), { target: { value: 'APP' } })
    expect(options()[0]).toBe('src/app.ts')
    expect(options()).not.toContain('README.md')
    fireEvent.change(input(), { target: { value: 'zzzz' } })
    expect(screen.queryAllByRole('option')).toHaveLength(0)
    expect(screen.getByText(QUICK_TEXT.none)).toBeTruthy()
  })

  it('arrow keys move the active option, Enter opens it and closes', async () => {
    const { input, onOpen, onClose } = setup()
    await waitFor(() => expect(options()).toHaveLength(FILES.length))
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    fireEvent.keyDown(input(), { key: 'ArrowUp' })
    expect(screen.getAllByRole('option')[1].getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(onOpen).toHaveBeenCalledWith('src/app.ts')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does not run past the ends of the list', async () => {
    const { input, onOpen } = setup()
    await waitFor(() => expect(options()).toHaveLength(FILES.length))
    for (let i = 0; i < 10; i++) fireEvent.keyDown(input(), { key: 'ArrowDown' })
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(onOpen).toHaveBeenCalledWith(FILES[FILES.length - 1])
  })

  it('Escape closes without opening anything', async () => {
    const { input, onOpen, onClose } = setup()
    await waitFor(() => expect(options()).toHaveLength(FILES.length))
    fireEvent.keyDown(input(), { key: 'Escape' })
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('click opens that file', async () => {
    const { onOpen } = setup()
    await waitFor(() => expect(options()).toHaveLength(FILES.length))
    fireEvent.click(screen.getByText('src/a/p/xp.ts'))
    expect(onOpen).toHaveBeenCalledWith('src/a/p/xp.ts')
  })

  it('Enter with no results does nothing', async () => {
    const { input, onOpen, onClose } = setup()
    await waitFor(() => expect(options()).toHaveLength(FILES.length))
    fireEvent.change(input(), { target: { value: 'zzzz' } })
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(onOpen).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('shows the server error and the truncation note', async () => {
    fs.search.mockResolvedValueOnce({ ok: false, code: 'EIO', error: 'boom' })
    setup()
    expect((await screen.findByRole('alert')).textContent).toBe(QUICK_TEXT.failed + 'boom')
    cleanup()
    fs.search.mockResolvedValueOnce({ ok: true, files: FILES, truncated: true })
    setup()
    expect(await screen.findByText(QUICK_TEXT.truncated)).toBeTruthy()
  })
})
