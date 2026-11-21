/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SHOT_IGNORE_ATTR } from '../../canvasShot'
import type { FrameResult } from '../shot.capture'
import { SHOT_TEXT } from './shot.ui.text'

const m = vi.hoisted(() => ({
  captureFrame: vi.fn(), exportPng: vi.fn(), copyImage: vi.fn(), saveImage: vi.fn(), showNotice: vi.fn(), closeNotice: vi.fn(),
}))
vi.mock('../shot.capture', () => ({ captureFrame: m.captureFrame }))
vi.mock('../shot.export', () => ({ exportPng: m.exportPng, copyImage: m.copyImage, saveImage: m.saveImage, shotFileName: () => 'webterm-test.png' }))
vi.mock('@/workspaceSave.notice', () => ({ showNotice: m.showNotice, closeNotice: m.closeNotice }))

import { ScreenshotHost } from './ScreenshotHost'
import { startScreenshot } from './screenshot.start'

const OK: FrameResult = { ok: true, frame: Object.assign(document.createElement('canvas'), { width: 2000, height: 1200 }), cssWidth: 1000, cssHeight: 600, scale: 2 }
const ev = (x: number, y: number) => ({ clientX: x, clientY: y, button: 0, isPrimary: true, pointerId: 1 })
const ctrl = { ctrlKey: true }

async function openOverlay(): Promise<HTMLElement> {
  render(<TooltipProvider><button>before</button><ScreenshotHost /></TooltipProvider>)
  screen.getByText('before').focus()
  await act(async () => { startScreenshot() })
  return screen.findByRole('dialog')
}
const key = (el: Element, init: KeyboardEventInit) => fireEvent.keyDown(el, init)
const selectAll = async (dialog: HTMLElement) => { key(dialog, { key: 'Enter' }); await screen.findByRole('toolbar', { name: SHOT_TEXT.rail }) }
const lastNotice = () => m.showNotice.mock.calls.at(-1)?.[1] as { severity: string; title: string; actions?: { label: string; onClick: () => void }[] }

beforeEach(() => {
  m.captureFrame.mockResolvedValue(OK)
  m.exportPng.mockResolvedValue(new Blob(['x'], { type: 'image/png' }))
  m.copyImage.mockResolvedValue('ok')
  // jsdom has no 2D context; the preview paints nothing here (drawing is covered by the render tests).
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); Object.values(m).forEach((f) => f.mockReset()) })

describe('capture', () => {
  test('shows a blocking indicator outside the picture, then the modal dialog', async () => {
    let finish!: (r: FrameResult) => void
    m.captureFrame.mockReturnValue(new Promise<FrameResult>((r) => { finish = r }))
    render(<TooltipProvider><ScreenshotHost /></TooltipProvider>)
    act(() => startScreenshot())
    const busy = screen.getByRole('status')
    expect(busy.textContent).toBe(SHOT_TEXT.capturing)
    expect(busy.hasAttribute(SHOT_IGNORE_ATTR)).toBe(true)
    act(() => startScreenshot()) // a second request while capturing is ignored
    expect(m.captureFrame).toHaveBeenCalledOnce()
    await act(async () => finish(OK))
    const dialog = await screen.findByRole('dialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.getAttribute('aria-label')).toBe(SHOT_TEXT.dialog)
    expect(dialog.hasAttribute(SHOT_IGNORE_ATTR)).toBe(true)
  })

  test.each([['page_too_large', 'Try again'], ['failed', 'Try again'], ['busy', undefined]] as const)('%s is an error notice, never silent', async (reason, action) => {
    m.captureFrame.mockResolvedValue({ ok: false, reason })
    render(<TooltipProvider><ScreenshotHost /></TooltipProvider>)
    await act(async () => { startScreenshot() })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(lastNotice().severity).toBe('error')
    expect(lastNotice().title).toBe(SHOT_TEXT.errors[reason].title)
    expect(lastNotice().actions?.map((a) => a.label) ?? []).toEqual(action ? [action] : [])
  })

  test('Try again starts a new capture', async () => {
    m.captureFrame.mockResolvedValueOnce({ ok: false, reason: 'failed' })
    render(<TooltipProvider><ScreenshotHost /></TooltipProvider>)
    await act(async () => { startScreenshot() })
    await act(async () => { lastNotice().actions![0].onClick() })
    expect(m.captureFrame).toHaveBeenCalledTimes(2)
    await screen.findByRole('dialog')
  })

  test('pressing the shortcut again while open closes it (the same command toggles)', async () => {
    await openOverlay()
    await act(async () => { startScreenshot() })
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('keyboard and focus', () => {
  test('Enter selects the whole window and shows the tool rail and the action bar', async () => {
    const dialog = await openOverlay()
    expect(screen.queryByRole('toolbar')).toBeNull()
    await selectAll(dialog)
    expect(screen.getByRole('toolbar', { name: SHOT_TEXT.actions })).toBeTruthy()
    expect(screen.getByLabelText(/^Selection 2000x1200/)).toBeTruthy()
    expect(screen.getByText('2000x1200')).toBeTruthy()
  })

  test('Escape closes and focus returns to the element that had it', async () => {
    const dialog = await openOverlay()
    expect(document.activeElement).toBe(dialog)
    key(dialog, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(screen.getByText('before'))
  })

  test('Tab wraps inside the dialog (focus trap)', async () => {
    const dialog = await openOverlay()
    await selectAll(dialog)
    const buttons = within(dialog).getAllByRole('button').filter((b) => !(b as HTMLButtonElement).disabled)
    buttons[buttons.length - 1].focus()
    key(buttons[buttons.length - 1], { key: 'Tab' })
    expect(document.activeElement).not.toBe(buttons[buttons.length - 1])
    expect(dialog.contains(document.activeElement)).toBe(true)
    key(document.activeElement!, { key: 'Tab', shiftKey: true }) // back from the first stop wraps to the last
    expect(dialog.contains(document.activeElement)).toBe(true)
  })

  test('the overlay is modal: its keys never reach the global shortcut listener', async () => {
    const dialog = await openOverlay()
    const leaked = vi.fn()
    document.addEventListener('keydown', leaked)
    key(dialog, { key: 'k', code: 'KeyK', ctrlKey: true })
    key(dialog, { key: 'p', code: 'KeyP', ctrlKey: true })
    document.removeEventListener('keydown', leaked)
    expect(leaked).not.toHaveBeenCalled()
  })

  test('Ctrl+Z and Ctrl+Shift+Z undo and redo a shape', async () => {
    const dialog = await openOverlay()
    await selectAll(dialog)
    fireEvent.click(screen.getByRole('button', { name: 'Rectangle' }))
    const surface = screen.getByTestId('shot-surface')
    fireEvent.pointerDown(surface, ev(100, 100))
    fireEvent.pointerUp(surface, ev(200, 200))
    const undo = screen.getByRole('button', { name: SHOT_TEXT.undo }) as HTMLButtonElement
    expect(undo.disabled).toBe(false)
    key(dialog, { key: 'z', code: 'KeyZ', ...ctrl })
    expect((screen.getByRole('button', { name: SHOT_TEXT.undo }) as HTMLButtonElement).disabled).toBe(true)
    key(dialog, { key: 'Z', code: 'KeyZ', ...ctrl, shiftKey: true })
    expect((screen.getByRole('button', { name: SHOT_TEXT.undo }) as HTMLButtonElement).disabled).toBe(false)
  })
})

describe('tools', () => {
  test('tool buttons toggle aria-pressed; undo and redo start disabled', async () => {
    const dialog = await openOverlay()
    await selectAll(dialog)
    const pen = screen.getByRole('button', { name: 'Pen' })
    expect(pen.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(pen)
    expect(pen.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Marker' }))
    expect(pen.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(screen.getByRole('button', { name: 'Marker' }))
    expect(screen.getByRole('button', { name: 'Marker' }).getAttribute('aria-pressed')).toBe('false')
    expect((screen.getByRole('button', { name: SHOT_TEXT.undo }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: SHOT_TEXT.redo }) as HTMLButtonElement).disabled).toBe(true)
  })

  test('the color picker lists preset swatches and remembers the choice', async () => {
    const dialog = await openOverlay()
    await selectAll(dialog)
    fireEvent.click(screen.getByRole('button', { name: SHOT_TEXT.color }))
    const group = screen.getByRole('group', { name: SHOT_TEXT.colorPicker })
    expect(within(group).getByRole('button', { name: 'Red' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(within(group).getByRole('button', { name: 'Blue' }))
    expect(within(group).getByRole('button', { name: 'Blue' }).getAttribute('aria-pressed')).toBe('true')
    expect(JSON.parse(localStorage.getItem('webterm.screenshot.prefs')!).color).toBe('#0a84ff')
    localStorage.clear()
  })

  test('text: click, type, Enter adds it; Escape cancels only the text', async () => {
    const dialog = await openOverlay()
    await selectAll(dialog)
    fireEvent.click(screen.getByRole('button', { name: 'Text' }))
    const surface = screen.getByTestId('shot-surface')
    fireEvent.pointerDown(surface, ev(100, 100))
    let field = await screen.findByRole('textbox', { name: SHOT_TEXT.textInput })
    fireEvent.change(field, { target: { value: 'hello' } })
    key(field, { key: 'Escape' })
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.getByRole('dialog')).toBeTruthy() // the overlay is still open
    expect((screen.getByRole('button', { name: SHOT_TEXT.undo }) as HTMLButtonElement).disabled).toBe(true)

    fireEvent.pointerDown(surface, ev(100, 100))
    field = await screen.findByRole('textbox')
    fireEvent.change(field, { target: { value: 'hello' } })
    key(field, { key: 'Enter' })
    expect(screen.queryByRole('textbox')).toBeNull()
    expect((screen.getByRole('button', { name: SHOT_TEXT.undo }) as HTMLButtonElement).disabled).toBe(false)
  })

  test('empty text is ignored, and Ctrl+C in the text field is not taken as "copy screenshot"', async () => {
    const dialog = await openOverlay()
    await selectAll(dialog)
    fireEvent.click(screen.getByRole('button', { name: 'Text' }))
    fireEvent.pointerDown(screen.getByTestId('shot-surface'), ev(100, 100))
    const field = await screen.findByRole('textbox')
    key(field, { key: 'c', code: 'KeyC', ...ctrl })
    expect(m.exportPng).not.toHaveBeenCalled()
    key(field, { key: 'Enter' })
    expect((screen.getByRole('button', { name: SHOT_TEXT.undo }) as HTMLButtonElement).disabled).toBe(true)
  })

  test('arrow keys on the focused selection move it; Shift+arrow resizes it', async () => {
    const dialog = await openOverlay()
    fireEvent.pointerDown(screen.getByTestId('shot-surface'), ev(10, 10))
    fireEvent.pointerUp(screen.getByTestId('shot-surface'), ev(110, 110))
    const sel = await screen.findByLabelText(/^Selection 200x200/)
    key(sel, { key: 'ArrowRight', shiftKey: true })
    expect(screen.getByText('210x200')).toBeTruthy()
    key(sel, { key: 'ArrowRight' })
    expect(dialog.contains(sel)).toBe(true)
  })
})

describe('copy and save', () => {
  test('Copy writes the PNG, closes and says so', async () => {
    const dialog = await openOverlay()
    await selectAll(dialog)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: SHOT_TEXT.copy })) })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(m.copyImage).toHaveBeenCalledOnce()
    expect(lastNotice()).toMatchObject({ severity: 'info', title: SHOT_TEXT.copied })
  })

  test('Ctrl+C copies the selection', async () => {
    const dialog = await openOverlay()
    await selectAll(dialog)
    await act(async () => { key(dialog, { key: 'c', code: 'KeyC', ...ctrl }) })
    await waitFor(() => expect(m.copyImage).toHaveBeenCalledOnce())
  })

  test('a copy that is denied or unsupported stays open and offers Save as the way out', async () => {
    for (const result of ['denied', 'unsupported'] as const) {
      m.copyImage.mockResolvedValue(result)
      m.saveImage.mockReset()
      const dialog = await openOverlay()
      await selectAll(dialog)
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: SHOT_TEXT.copy })) })
      await waitFor(() => expect(lastNotice().severity).toBe('error'))
      expect(screen.getByRole('dialog')).toBeTruthy()
      expect(lastNotice().actions!.map((a) => a.label)).toEqual([SHOT_TEXT.saveAction])
      await act(async () => { lastNotice().actions![0].onClick() })
      await waitFor(() => expect(m.saveImage).toHaveBeenCalledWith(expect.any(Blob), 'webterm-test.png'))
      cleanup()
    }
  })

  test('Ctrl+S saves with the generated file name and closes', async () => {
    const dialog = await openOverlay()
    await selectAll(dialog)
    await act(async () => { key(dialog, { key: 's', code: 'KeyS', ...ctrl }) })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(m.saveImage).toHaveBeenCalledWith(expect.any(Blob), 'webterm-test.png')
    expect(lastNotice().title).toBe('Saved webterm-test.png')
  })

  test('an encoding failure is an error notice and the work is kept', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    m.exportPng.mockRejectedValue(new Error('encode'))
    const dialog = await openOverlay()
    await selectAll(dialog)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: SHOT_TEXT.save })) })
    await waitFor(() => expect(lastNotice().title).toBe(SHOT_TEXT.errors.saveFailed.title))
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(m.saveImage).not.toHaveBeenCalled()
  })

  test('while copying, the actions are disabled and the live region says so', async () => {
    let done!: (v: 'ok') => void
    m.copyImage.mockReturnValue(new Promise((r) => { done = r }))
    const dialog = await openOverlay()
    await selectAll(dialog)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: SHOT_TEXT.copy })) })
    expect((screen.getByRole('button', { name: SHOT_TEXT.copy }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: SHOT_TEXT.save }) as HTMLButtonElement).disabled).toBe(true)
    expect(dialog.getAttribute('aria-busy')).toBe('true')
    expect(within(dialog).getByText(SHOT_TEXT.busy.copying, { selector: '.shot-sr' })).toBeTruthy()
    key(dialog, { key: 'Escape' }) // an export in flight finishes first
    expect(screen.getByRole('dialog')).toBeTruthy()
    await act(async () => done('ok'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  test('the screenshot never touches the network or a new window', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const open = vi.spyOn(window, 'open')
    const dialog = await openOverlay()
    await selectAll(dialog)
    await act(async () => { key(dialog, { key: 's', code: 'KeyS', ...ctrl }) })
    await waitFor(() => expect(m.saveImage).toHaveBeenCalled())
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})
