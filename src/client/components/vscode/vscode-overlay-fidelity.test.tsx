/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VscodeDialog } from './vscodeDialog'
import { arrangeDialogButtons, detectDialogPlatform } from './vscodeDialogButtons'
import { VscodeMenu } from './vscodeMenu'
import { VscodeNotification, VscodeNotificationStack } from './vscodeNotification'
import { VscodeQuickPick, type VscodeQuickPickItem } from './vscodeQuickPick'
import { highlightSegments } from './vscodeQuickPickRanking'
import { VscodeTooltip } from './vscodeTooltip'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('arrangeDialogButtons (VS Code rearrangeButtons)', () => {
  const logical = ['Delete', 'Keep', 'Cancel']

  it('puts cancel last on Windows', () => {
    expect(arrangeDialogButtons(logical, 2, 'windows')).toEqual(['Delete', 'Keep', 'Cancel'])
    expect(arrangeDialogButtons(['Delete', 'Cancel', 'Keep'], 1, 'windows')).toEqual(['Delete', 'Keep', 'Cancel'])
  })

  it('puts cancel before the primary, primary trailing, on macOS and Linux', () => {
    expect(arrangeDialogButtons(['OK', 'Cancel'], 1, 'mac')).toEqual(['Cancel', 'OK'])
    expect(arrangeDialogButtons(logical, 2, 'linux')).toEqual(['Keep', 'Cancel', 'Delete'])
  })

  it('reverses without a cancel button on non-Windows and keeps order on Windows', () => {
    expect(arrangeDialogButtons(['A', 'B'], undefined, 'mac')).toEqual(['B', 'A'])
    expect(arrangeDialogButtons(['A', 'B'], undefined, 'windows')).toEqual(['A', 'B'])
    expect(arrangeDialogButtons(['A'], 0, 'mac')).toEqual(['A'])
  })

  it('does not mutate its input and detects the platform string', () => {
    const input = ['OK', 'Cancel']
    arrangeDialogButtons(input, 1, 'mac')
    expect(input).toEqual(['OK', 'Cancel'])
    expect(detectDialogPlatform('Win32')).toBe('windows')
    expect(detectDialogPlatform('MacIntel')).toBe('mac')
    expect(detectDialogPlatform('Linux x86_64')).toBe('linux')
  })
})

describe('VscodeDialog close affordance', () => {
  it('draws the close button as a codicon, not a text glyph', () => {
    render(<VscodeDialog open onOpenChange={() => {}} title="Rename"><p>Body</p></VscodeDialog>)
    const close = screen.getByRole('button', { name: 'Close dialog' })
    expect(close.querySelector('.codicon.codicon-close')).not.toBeNull()
    expect(close.textContent).toBe('')
  })
})

describe('VscodeTooltip', () => {
  it('removes the native title so the hover is not shown twice', () => {
    render(
      <VscodeTooltip content="Save the file">
        <button type="button" title="Save the file">Save</button>
      </VscodeTooltip>,
    )
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('title')).toBe(false)
  })
})

describe('VscodeMenu fidelity', () => {
  it('shows a row title as a native hint, codicon check and chevron, and keeps keys off the window', () => {
    const onWindowKey = vi.fn()
    window.addEventListener('keydown', onWindowKey)
    render(
      <VscodeMenu
        open
        anchor={{ x: 4, y: 4 }}
        onClose={() => {}}
        ariaLabel="Actions"
        items={[
          { type: 'item', id: 'a', label: 'Sort', checked: true, title: 'Sort by name' },
          { type: 'item', id: 'b', label: 'More', submenu: [{ type: 'item', id: 'c', label: 'Inner' }] },
        ]}
      />,
    )
    const sort = screen.getByRole('menuitemcheckbox', { name: /Sort/ })
    expect(sort.getAttribute('title')).toBe('Sort by name')
    expect(sort.querySelector('.codicon-check')).not.toBeNull()
    expect(screen.getByRole('menuitem', { name: /More/ }).querySelector('.codicon-chevron-right')).not.toBeNull()
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowDown' })
    expect(onWindowKey).not.toHaveBeenCalled()
    window.removeEventListener('keydown', onWindowKey)
  })
})

describe('VscodeNotification fidelity', () => {
  it('uses codicon severity icons and a codicon close', () => {
    render(<VscodeNotification id="n" severity="error" title="Save failed" onClose={() => {}} />)
    const toast = screen.getByRole('alert')
    expect(toast.querySelector('.codicon-error')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Close notification' }).querySelector('.codicon-close')).not.toBeNull()
  })

  it('stacks several toasts inside one bottom-right container', () => {
    render(
      <VscodeNotificationStack>
        <VscodeNotification id="a" severity="warning" title="One" onClose={() => {}} />
        <VscodeNotification id="b" severity="info" title="Two" onClose={() => {}} />
      </VscodeNotificationStack>,
    )
    const stacks = document.querySelectorAll('.vscode-notification-stack')
    expect(stacks).toHaveLength(1)
    expect(stacks[0].querySelectorAll('.vscode-notification')).toHaveLength(2)
  })

  it('renders determinate and infinite progress bars', () => {
    const { rerender } = render(<VscodeNotification id="p" severity="warning" title="Copying" progress={40} onClose={() => {}} />)
    const bar = screen.getByRole('progressbar')
    expect(bar.getAttribute('aria-valuenow')).toBe('40')
    expect((bar.firstElementChild as HTMLElement).style.width).toBe('40%')
    rerender(<VscodeNotification id="p" severity="warning" title="Copying" progress="infinite" onClose={() => {}} />)
    expect(screen.getByRole('progressbar').getAttribute('data-mode')).toBe('infinite')
    expect(screen.getByRole('progressbar').hasAttribute('aria-valuenow')).toBe(false)
  })

  it('stays out of the DOM progress role when no progress is given', () => {
    render(<VscodeNotification id="q" severity="info" title="Done" onClose={() => {}} />)
    expect(screen.queryByRole('progressbar')).toBeNull()
    act(() => {})
  })
})

describe('quick pick highlight', () => {
  it('marks a contiguous match, a fuzzy subsequence, and nothing for a miss', () => {
    expect(highlightSegments('Open Settings', 'set')).toEqual([
      { text: 'Open ', match: false },
      { text: 'Set', match: true },
      { text: 'tings', match: false },
    ])
    expect(highlightSegments('Open Settings', 'ost').filter((s) => s.match).map((s) => s.text).join('')).toBe('OSt')
    expect(highlightSegments('Open', 'zz')).toEqual([{ text: 'Open', match: false }])
    expect(highlightSegments('Open', '  ')).toEqual([{ text: 'Open', match: false }])
  })
})

describe('VscodeQuickPick fidelity', () => {
  const many: VscodeQuickPickItem[] = Array.from({ length: 30 }, (_, i) => ({ id: `n${i}`, label: `Node ${i}` }))

  function renderPick(extra: Partial<React.ComponentProps<typeof VscodeQuickPick>> = {}, items = many) {
    return render(
      <VscodeQuickPick open onClose={() => {}} placeholder="Find" items={items} onSelect={() => {}} {...extra} />,
    )
  }

  it('shows the confirm/cancel hint unless hidden', () => {
    const { unmount } = renderPick()
    expect(screen.getByText('Press Enter to confirm or Escape to cancel')).not.toBeNull()
    unmount()
    renderPick({ hint: '' })
    expect(document.querySelector('[data-slot="vscode-quick-pick-hint"]')).toBeNull()
  })

  it('highlights matched characters in the label', () => {
    renderPick({ items: [{ id: 'a', label: 'Open Settings' }] })
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'set' } })
    const marks = document.querySelectorAll('[data-slot="vscode-quick-pick-highlight"]')
    expect(Array.from(marks).map((m) => m.textContent).join('')).toBe('Set')
    expect(screen.getByRole('option').textContent).toBe('Open Settings')
  })

  it('pages with PageDown and PageUp and clamps at the ends', () => {
    renderPick()
    const input = screen.getByRole('combobox')
    const activeLabel = () => document.querySelector('[data-active="true"]')?.textContent
    expect(activeLabel()).toBe('Node 0')
    fireEvent.keyDown(input, { key: 'PageDown' })
    expect(activeLabel()).toBe('Node 19')
    fireEvent.keyDown(input, { key: 'PageDown' })
    expect(activeLabel()).toBe('Node 29')
    fireEvent.keyDown(input, { key: 'PageUp' })
    expect(activeLabel()).toBe('Node 10')
    fireEvent.keyDown(input, { key: 'PageUp' })
    fireEvent.keyDown(input, { key: 'PageUp' })
    expect(activeLabel()).toBe('Node 0')
  })

  it('lands on the nearest enabled row when paging onto a disabled one', () => {
    const items = many.map((item, i) => (i === 19 ? { ...item, disabled: true } : item))
    renderPick({}, items)
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'PageDown' })
    expect(document.querySelector('[data-active="true"]')?.textContent).toBe('Node 20')
  })

  it('ignores a configured mode prefix when ranking', () => {
    renderPick({ modePrefix: '>', items: [{ id: 'a', label: 'Open Settings' }, { id: 'b', label: 'Close Tab' }] })
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '>close' } })
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Close Tab'])
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '>' } })
    expect(screen.getAllByRole('option')).toHaveLength(2)
  })
})
