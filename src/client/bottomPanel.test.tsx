/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PANEL_HEIGHT_KEY, PANEL_MIN_HEIGHT, SASH_STEP, SASH_STEP_LARGE, clampPanelHeight, currentPanelHeight,
  heightAfterKey, panelMaxHeight, reloadPanelHeightFromStorage, resetPanelHeight, setPanelHeight,
} from './bottomPanelHeight'
import { heightAfterDrag } from './bottomPanelSash'
import { InboxPanelSurface } from './inboxPanelSurface'

const WINDOW_HEIGHT = 1000

/** Visible tooltip of `el` (focus opens it); the label is the tooltip, not a native `title`. */
const tipOf = (el: Element): string | null => {
  fireEvent.focus(el)
  const text = document.querySelector('[role="tooltip"]')?.textContent ?? null
  fireEvent.blur(el)
  return text
}

beforeEach(() => {
  vi.stubGlobal('innerHeight', WINDOW_HEIGHT)
  localStorage.clear()
  reloadPanelHeightFromStorage()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  localStorage.clear()
  reloadPanelHeightFromStorage()
  document.documentElement.style.removeProperty('--bottom-panel-h')
})

function renderSurface(onClosePanel = vi.fn(), onClose = vi.fn()) {
  const onActivate = vi.fn()
  render(
    <InboxPanelSurface
      ariaLabel="Panel" tabs={[{ id: 'a', label: 'Problems', badge: 3 }, { id: 'b', label: 'Chat' }]}
      activeId="a" onActivate={onActivate} onClose={onClose} onClosePanel={onClosePanel}
    >
      <p>body</p>
    </InboxPanelSurface>
  )
  return { onActivate, onClosePanel, onClose }
}

describe('panel height model', () => {
  it('defaults to 40% of the window and clamps into [77px, 80%]', () => {
    expect(currentPanelHeight()).toBe(400)
    expect(clampPanelHeight(10)).toBe(PANEL_MIN_HEIGHT)
    expect(clampPanelHeight(5000)).toBe(panelMaxHeight())
    expect(panelMaxHeight()).toBe(800)
  })

  it('persists a chosen height and double-click style reset forgets it', () => {
    setPanelHeight(300)
    expect(localStorage.getItem(PANEL_HEIGHT_KEY)).toBe('300')
    reloadPanelHeightFromStorage()
    expect(currentPanelHeight()).toBe(300)
    resetPanelHeight()
    expect(localStorage.getItem(PANEL_HEIGHT_KEY)).toBeNull()
    expect(currentPanelHeight()).toBe(400)
  })

  it('maps sash keys to 10px / 50px steps and the min / max ends', () => {
    expect(heightAfterKey('ArrowUp', false, 400)).toBe(400 + SASH_STEP)
    expect(heightAfterKey('ArrowDown', true, 400)).toBe(400 - SASH_STEP_LARGE)
    expect(heightAfterKey('Home', false, 400)).toBe(PANEL_MIN_HEIGHT)
    expect(heightAfterKey('End', false, 400)).toBe(800)
    expect(heightAfterKey('a', false, 400)).toBeNull()
  })

  it('grows the panel when the sash is dragged upwards', () => {
    expect(heightAfterDrag(400, 600, 550)).toBe(450)
    expect(heightAfterDrag(400, 600, 650)).toBe(350)
  })
})

describe('InboxPanelSurface chrome', () => {
  it('renders uppercase-tab strip, a badge, a sash and the toolbar', () => {
    renderSurface()
    expect(document.querySelector('.vscode-panel-tabs')).not.toBeNull()
    expect(screen.getByLabelText('3 items').textContent).toBe('3')
    expect(screen.getByRole('separator', { name: 'Resize panel' }).getAttribute('aria-valuenow')).toBe('400')
    expect(screen.getByRole('tab', { name: /Problems/ }).getAttribute('aria-selected')).toBe('true')
  })

  it('resizes with the keyboard, mirrors --bottom-panel-h and persists', () => {
    renderSurface()
    const sash = screen.getByRole('separator', { name: 'Resize panel' })
    fireEvent.keyDown(sash, { key: 'ArrowUp' })
    expect(sash.getAttribute('aria-valuenow')).toBe('410')
    expect(document.documentElement.style.getPropertyValue('--bottom-panel-h')).toBe('410px')
    expect(localStorage.getItem(PANEL_HEIGHT_KEY)).toBe('410')
    fireEvent.doubleClick(sash)
    expect(sash.getAttribute('aria-valuenow')).toBe('400')
    expect(localStorage.getItem(PANEL_HEIGHT_KEY)).toBeNull()
  })

  it('maximize toggles the panel and the label follows', () => {
    renderSurface()
    expect(tipOf(screen.getByRole('button', { name: 'Maximize Panel Size' }))).toBe('Click to maximize the panel')
    fireEvent.click(screen.getByRole('button', { name: 'Maximize Panel Size' }))
    expect(tipOf(screen.getByRole('button', { name: 'Restore Panel Size' }))).toBe('Panel maximized. Click to restore its size')
    expect(document.querySelector('.vscode-bottom-panel')?.getAttribute('data-maximized')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Restore Panel Size' }))
    expect(document.querySelector('.vscode-bottom-panel')?.getAttribute('data-maximized')).toBe('false')
  })

  it('closes the panel from the toolbar and a tab from its close button', () => {
    const { onClosePanel, onClose } = renderSurface()
    expect(screen.getByRole('button', { name: 'Close Panel' }).hasAttribute('title')).toBe(false)
    expect(tipOf(screen.getByRole('button', { name: 'Close Panel' }))).toBe('Close Panel')
    fireEvent.click(screen.getByRole('button', { name: 'Close Panel' }))
    expect(onClosePanel).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Close Chat' }))
    expect(onClose).toHaveBeenCalledWith('b')
  })

  it('moves tab focus with arrows and activates with Enter', () => {
    const { onActivate } = renderSurface()
    const first = screen.getByRole('tab', { name: /Problems/ })
    first.focus()
    fireEvent.keyDown(first, { key: 'ArrowRight' })
    const second = screen.getByRole('tab', { name: /Chat/ })
    expect(document.activeElement).toBe(second)
    act(() => { fireEvent.keyDown(second, { key: 'Enter' }) })
    expect(onActivate).toHaveBeenCalledWith('b')
  })
})
