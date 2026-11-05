/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chordLabel, registerCommands } from '@/commandRegistry'
import { setKeybinding, resetKeybinding } from '@/keybindings.store'
import { isMacPlatform } from '@/terminalKeys'
import { VscodeDialog } from '@/components/vscode/vscodeDialog'
import { IconButton, LONG_PRESS_MS } from './icon-button'
import { TOOLTIP_DELAY_MS, TooltipProvider } from './tooltip'

const tooltip = () => screen.queryByRole('tooltip')
const hover = (el: Element) => fireEvent.pointerMove(el, { pointerType: 'mouse' })

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('IconButton', () => {
  it('uses label as the accessible name and sets no native title', () => {
    render(<IconButton label="Toggle inbox panel"><span className="codicon codicon-inbox" /></IconButton>)
    const btn = screen.getByRole('button', { name: 'Toggle inbox panel' })
    expect(btn.getAttribute('aria-label')).toBe('Toggle inbox panel')
    expect(btn.hasAttribute('title')).toBe(false)
  })

  it('opens on hover only after the delay, with the shortcut read from the command registry', () => {
    const unregister = registerCommands([{ id: 'test.inbox', label: 'View: Inbox', defaultKey: 'Mod+Shift+I', run: () => {} }])
    render(<TooltipProvider><IconButton label="Inbox" commandId="test.inbox"><span /></IconButton></TooltipProvider>)
    hover(screen.getByRole('button', { name: 'Inbox' }))
    act(() => { vi.advanceTimersByTime(TOOLTIP_DELAY_MS - 50) })
    expect(tooltip()).toBeNull()
    act(() => { vi.advanceTimersByTime(100) })
    expect(tooltip()?.textContent).toBe(`Inbox ${chordLabel('Mod+Shift+I', isMacPlatform())}`)
    unregister()
  })

  it('follows a user keybinding override, so the tooltip never drifts', () => {
    const unregister = registerCommands([{ id: 'test.rebound', label: 'Test', defaultKey: 'Mod+J', run: () => {} }])
    setKeybinding('test.rebound', 'Mod+Alt+J')
    render(<IconButton label="Rebound" commandId="test.rebound"><span /></IconButton>)
    fireEvent.keyDown(document, { key: 'Tab' }) // keyboard navigation: focus alone does not open a tooltip
    fireEvent.focus(screen.getByRole('button', { name: 'Rebound' }))
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(`Rebound ${chordLabel('Mod+Alt+J', isMacPlatform())}`)
    resetKeybinding('test.rebound')
    unregister()
  })

  it('opens at once on keyboard focus', () => {
    render(<IconButton label="Settings" shortcut="⌘,"><span /></IconButton>)
    fireEvent.keyDown(document, { key: 'Tab' }) // keyboard navigation: focus alone does not open a tooltip
    fireEvent.focus(screen.getByRole('button', { name: 'Settings' }))
    expect(tooltip()?.textContent).toBe('Settings ⌘,')
  })

  it('still shows a tooltip on a disabled button, with the reason', () => {
    render(<IconButton label="Undo" disabled disabledReason="nothing to undo"><span /></IconButton>)
    const btn = screen.getByRole('button', { name: 'Undo' }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    const wrapper = btn.parentElement!
    expect(wrapper.getAttribute('data-slot')).toBe('icon-tooltip-disabled')
    hover(wrapper)
    act(() => { vi.advanceTimersByTime(TOOLTIP_DELAY_MS + 10) })
    expect(tooltip()?.textContent).toBe('Undo (nothing to undo)')
  })

  it('opens on a touch long-press and swallows the click that ends it', () => {
    const onClick = vi.fn()
    render(<IconButton label="Problems" onClick={onClick}><span /></IconButton>)
    const btn = screen.getByRole('button', { name: 'Problems' })
    fireEvent.pointerDown(btn, { pointerType: 'touch' })
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS - 50) })
    expect(tooltip()).toBeNull()
    act(() => { vi.advanceTimersByTime(100) })
    expect(tooltip()?.textContent).toBe('Problems')
    fireEvent.pointerUp(btn, { pointerType: 'touch' })
    fireEvent.click(btn)
    expect(onClick).not.toHaveBeenCalled()
    // A plain tap afterwards is a normal click again.
    fireEvent.click(btn)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('a short tap does not open the tooltip', () => {
    render(<IconButton label="Fit"><span /></IconButton>)
    const btn = screen.getByRole('button', { name: 'Fit' })
    fireEvent.pointerDown(btn, { pointerType: 'touch' })
    act(() => { vi.advanceTimersByTime(100) })
    fireEvent.pointerUp(btn, { pointerType: 'touch' })
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS) })
    expect(tooltip()).toBeNull()
  })

  it('does not open on script focus, nor on focus after a pointer press or a non-navigation key', () => {
    render(<IconButton label="Settings"><span /></IconButton>)
    const btn = screen.getByRole('button', { name: 'Settings' })
    fireEvent.pointerDown(document.body)
    act(() => { btn.focus() })
    expect(tooltip()).toBeNull()
    act(() => { btn.blur() })
    fireEvent.keyDown(document, { key: 'Enter' }) // e.g. the shortcut that opened this surface
    act(() => { btn.focus() })
    expect(tooltip()).toBeNull()
  })
})

describe('IconTooltip in a VscodeDialog', () => {
  it('stays closed when the dialog autofocuses its close button, opens when Tab reaches it', () => {
    fireEvent.pointerDown(document.body) // the click that opens the dialog
    render(<VscodeDialog open onOpenChange={() => {}} title="Rename"><input aria-label="Name" /></VscodeDialog>)
    const close = screen.getByRole('button', { name: 'Close dialog' })
    expect(document.activeElement).toBe(close)
    expect(tooltip()).toBeNull()

    act(() => { screen.getByRole('textbox', { name: 'Name' }).focus() })
    fireEvent.keyDown(document, { key: 'Tab' })
    act(() => { close.focus() })
    expect(tooltip()?.textContent).toBe('Close dialog Esc')
  })
})
