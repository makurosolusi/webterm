/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VscodeDialog } from './vscodeDialog'
import { VscodeMenu, type VscodeMenuItem } from './vscodeMenu'
import { VscodeNotification } from './vscodeNotification'
import { placeAnchored, VscodePopover } from './vscodePopover'
import { VscodeTooltip } from './vscodeTooltip'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function rect(overrides: Partial<DOMRect> = {}): DOMRect {
  return { x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}), ...overrides } as DOMRect
}

function menuItems(onCopy = vi.fn(), onDelete = vi.fn()): VscodeMenuItem[] {
  return [
    { type: 'header', label: 'Edit' },
    { type: 'item', id: 'copy', label: 'Copy', keybinding: '⌘C', onSelect: onCopy },
    { type: 'separator' },
    { type: 'item', id: 'delete', label: 'Delete', danger: true, onSelect: onDelete },
    { type: 'item', id: 'other', label: 'Disabled', disabled: true },
  ]
}

function menuHarness(onTop = vi.fn()) {
  return function Harness() {
    const [open, setOpen] = useState(false)
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>Open menu</button>
        <VscodeMenu open={open} anchor={{ x: 10, y: 10 }} items={menuItems()} onClose={() => { setOpen(false); onTop() }} ariaLabel="Actions" />
      </>
    )
  }
}

describe('VscodeDialog', () => {
  it('portals a labelled modal, focuses its first control, and honours initialFocus', () => {
    const { rerender } = render(
      <VscodeDialog open onOpenChange={() => {}} title="Rename workspace" description="Choose a new name.">
        <input aria-label="Workspace name" />
      </VscodeDialog>,
    )
    const dialog = screen.getByRole('dialog', { name: 'Rename workspace' })
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.style.width).toBe('480px')
    expect(document.body.contains(dialog)).toBe(true)
    expect(dialog.getAttribute('aria-describedby')).toBe(screen.getByText('Choose a new name.').id)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close dialog' }))

    const inputRef = { current: null as HTMLElement | null }
    rerender(
      <VscodeDialog open={false} onOpenChange={() => {}} title="Rename workspace" initialFocus={inputRef}>
        <input aria-label="Workspace name" ref={(node) => { inputRef.current = node }} />
      </VscodeDialog>,
    )
    rerender(
      <VscodeDialog open onOpenChange={() => {}} title="Rename workspace" initialFocus={inputRef}>
        <input aria-label="Workspace name" ref={(node) => { inputRef.current = node }} />
      </VscodeDialog>,
    )
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Workspace name' }))
  })

  it('wraps Tab and Shift+Tab inside the dialog', () => {
    render(
      <VscodeDialog open onOpenChange={() => {}} title="Confirm" footer={<button type="button">Save</button>}>
        <button type="button">Body action</button>
      </VscodeDialog>,
    )
    const dialog = screen.getByRole('dialog', { name: 'Confirm' })
    const save = screen.getByRole('button', { name: 'Save' })
    const close = screen.getByRole('button', { name: 'Close dialog' })

    save.focus()
    fireEvent.keyDown(dialog, { key: 'Tab' })
    expect(document.activeElement).toBe(close)
    close.focus()
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(save)
  })

  it('closes on Escape and backdrop only when dismissible, then restores focus', () => {
    function Harness() {
      const [open, setOpen] = useState(false)
      const [dismissible, setDismissible] = useState(true)
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>Open dialog</button>
          <button type="button" onClick={() => setDismissible(false)}>Disable dismiss</button>
          <VscodeDialog open={open} onOpenChange={setOpen} title="Confirm" dismissible={dismissible} footer={<button type="button">Save</button>} />
        </>
      )
    }

    render(<Harness />)
    const trigger = screen.getByRole('button', { name: 'Open dialog' })
    trigger.focus()
    fireEvent.click(trigger)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)

    fireEvent.click(screen.getByRole('button', { name: 'Disable dismiss' }))
    fireEvent.click(trigger)
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.mouseDown(document.querySelector('.vscode-dialog-backdrop')!)
    expect(screen.queryByRole('dialog')).not.toBeNull()
  })
})

describe('VscodePopover', () => {
  it('renders an anchored dialog, focuses a control, and flips inside the viewport', () => {
    render(
      <VscodePopover anchor={rect({ left: 20, top: 20, right: 60, bottom: 40, width: 40, height: 20 })} open onOpenChange={() => {}} ariaLabel="Color">
        <button type="button">Red</button>
      </VscodePopover>,
    )
    const popover = screen.getByRole('dialog', { name: 'Color' })
    expect(document.body.contains(popover)).toBe(true)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Red' }))
    expect(popover.style.visibility).toBe('visible')

    const anchor = { left: 2, top: 740, right: 30, bottom: 760, width: 28, height: 20 }
    const placed = placeAnchored(anchor, { width: 100, height: 200 }, 'bottom', 4)
    expect(placed.left).toBe(8)
    expect(placed.top).toBe(anchor.top - 4 - 200)
  })

  it('closes on outside pointerdown and Escape, but not when its anchor is pressed', () => {
    const onOpenChange = vi.fn()
    function Harness() {
      const [anchor, setAnchor] = useState<HTMLElement | null>(null)
      return (
        <>
          <button type="button" ref={setAnchor}>Anchor</button>
          {anchor && (
            <VscodePopover anchor={anchor} open onOpenChange={onOpenChange} ariaLabel="Menu">
              <button type="button">Inside</button>
            </VscodePopover>
          )}
        </>
      )
    }
    render(<Harness />)

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Anchor' }))
    expect(onOpenChange).not.toHaveBeenCalled()
    fireEvent.pointerDown(document.body)
    expect(onOpenChange).toHaveBeenLastCalledWith(false)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onOpenChange).toHaveBeenCalledTimes(2)
  })
})

describe('VscodeTooltip', () => {
  it('waits 500ms on hover, links aria-describedby, and hides after 100ms', () => {
    vi.useFakeTimers()
    render(<VscodeTooltip content="Save the file"><button type="button">Save</button></VscodeTooltip>)
    const trigger = screen.getByRole('button', { name: 'Save' })

    fireEvent.pointerEnter(trigger)
    act(() => vi.advanceTimersByTime(499))
    expect(screen.queryByRole('tooltip')).toBeNull()
    act(() => vi.advanceTimersByTime(1))
    const tooltip = screen.getByRole('tooltip')
    expect(tooltip.textContent).toBe('Save the file')
    expect(trigger.getAttribute('aria-describedby')).toBe(tooltip.id)

    fireEvent.pointerLeave(trigger)
    act(() => vi.advanceTimersByTime(99))
    expect(screen.queryByRole('tooltip')).not.toBeNull()
    act(() => vi.advanceTimersByTime(1))
    expect(screen.queryByRole('tooltip')).toBeNull()
    expect(trigger.getAttribute('aria-describedby')).toBeNull()
  })

  it('shows immediately on focus and dismisses on Escape', () => {
    render(<VscodeTooltip content="Save the file"><button type="button">Save</button></VscodeTooltip>)
    const trigger = screen.getByRole('button', { name: 'Save' })
    fireEvent.focus(trigger)
    expect(screen.getByRole('tooltip')).not.toBeNull()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('tooltip')).toBeNull()
  })
})

describe('VscodeMenu', () => {
  it('portals a menu with header, separators, danger, and focusable disabled rows', () => {
    render(<VscodeMenu open anchor={{ x: 10, y: 10 }} items={menuItems()} onClose={() => {}} ariaLabel="Actions" />)
    const menu = screen.getByRole('menu', { name: 'Actions' })
    expect(document.body.contains(menu)).toBe(true)
    expect(menu.style.minWidth).toBe('160px')
    expect(screen.getByRole('menuitem', { name: 'Copy' }).getAttribute('data-active')).toBe('true')
    expect(screen.getByRole('menuitem', { name: 'Delete' }).getAttribute('data-danger')).toBe('true')
    const disabled = screen.getByRole('menuitem', { name: 'Disabled' })
    expect(disabled.getAttribute('aria-disabled')).toBe('true')
    expect((disabled as HTMLButtonElement).disabled).toBe(false)
    expect(screen.getByRole('separator')).not.toBeNull()
    expect(screen.getByText('Edit')).not.toBeNull()
  })

  it('moves with Arrow/Home/End, selects with Enter, and ignores disabled rows', () => {
    const onCopy = vi.fn()
    const onDelete = vi.fn()
    const onClose = vi.fn()
    render(<VscodeMenu open anchor={{ x: 10, y: 10 }} items={menuItems(onCopy, onDelete)} onClose={onClose} ariaLabel="Actions" />)
    const menu = screen.getByRole('menu')

    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Delete' }))
    fireEvent.keyDown(menu, { key: 'Home' })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Copy' }))
    fireEvent.keyDown(menu, { key: 'End' })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Disabled' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Disabled' }))
    fireEvent.keyDown(menu, { key: 'Enter' })
    expect(onDelete).not.toHaveBeenCalled()

    fireEvent.keyDown(menu, { key: 'd' })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Delete' }))
    fireEvent.keyDown(menu, { key: 'Enter' })
    expect(onDelete).toHaveBeenCalledTimes(1)
    expect(onCopy).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes on Escape and outside pointerdown, returning focus to the trigger', () => {
    const Harness = menuHarness()
    render(<Harness />)
    const trigger = screen.getByRole('button', { name: 'Open menu' })
    trigger.focus()
    fireEvent.click(trigger)
    expect(screen.getByRole('menu')).not.toBeNull()

    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(trigger)

    fireEvent.click(trigger)
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('opens a submenu with ArrowRight and closes one level with Escape', () => {
    const onTop = vi.fn()
    const items: VscodeMenuItem[] = [
      { type: 'item', id: 'share', label: 'Share', submenu: [{ type: 'item', id: 'link', label: 'Copy link', onSelect: vi.fn() }] },
      { type: 'item', id: 'close', label: 'Close', onSelect: vi.fn() },
    ]
    render(<VscodeMenu open anchor={{ x: 10, y: 10 }} items={items} onClose={onTop} ariaLabel="Actions" />)

    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowRight' })
    expect(screen.getAllByRole('menu')).toHaveLength(2)
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Copy link' }))

    fireEvent.keyDown(screen.getAllByRole('menu')[1], { key: 'Escape' })
    expect(screen.getAllByRole('menu')).toHaveLength(1)
    expect(onTop).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Share' }))
  })
})

describe('VscodeNotification', () => {
  it('renders status, message, actions, and closes on request', () => {
    const onClose = vi.fn()
    const onAction = vi.fn()
    render(
      <VscodeNotification id="save-failed" severity="info" title="Workspace saved" message="All changes are on disk." actions={[{ label: 'Undo', onClick: onAction }]} onClose={onClose} />,
    )
    const toast = screen.getByRole('status')
    expect(toast.getAttribute('data-severity')).toBe('info')
    expect(document.body.contains(toast)).toBe(true)
    expect(screen.getByText('All changes are on disk.')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(onAction).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Close notification' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('auto-dismisses info after 8s and pauses while hovered', () => {
    vi.useFakeTimers()
    const onClose = vi.fn()
    render(<VscodeNotification id="info" severity="info" title="Connected" onClose={onClose} />)
    const toast = screen.getByRole('status')
    act(() => vi.advanceTimersByTime(7999))
    expect(onClose).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(1))
    expect(onClose).toHaveBeenCalledTimes(1)

    onClose.mockClear()
    fireEvent.pointerEnter(toast)
    act(() => vi.advanceTimersByTime(9000))
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.pointerLeave(toast)
    act(() => vi.advanceTimersByTime(8000))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('never auto-dismisses warnings or errors', () => {
    vi.useFakeTimers()
    const onClose = vi.fn()
    const { rerender } = render(<VscodeNotification id="warn" severity="warning" title="Reconnecting" onClose={onClose} />)
    act(() => vi.advanceTimersByTime(20000))
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).not.toBeNull()

    rerender(<VscodeNotification id="err" severity="error" title="Save failed" onClose={onClose} />)
    act(() => vi.advanceTimersByTime(20000))
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').getAttribute('data-severity')).toBe('error')
  })
})
