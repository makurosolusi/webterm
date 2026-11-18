/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_HEADER_MODE, HEADER_MODE_KEY, HEADER_NOTICE_KEY, effectiveHeaderMode, getHeaderMode, headerNoticeDue, markHeaderNoticed,
  reloadHeaderModeFromStorage, setHeaderMode, toggleHeaderHidden,
} from './headerMode.store'

beforeEach(() => {
  localStorage.clear()
  reloadHeaderModeFromStorage()
})
afterEach(() => vi.restoreAllMocks())

describe('header mode store', () => {
  it('defaults to compact when nothing is stored, and the notice is due', () => {
    expect(DEFAULT_HEADER_MODE).toBe('compact')
    expect(getHeaderMode()).toBe('compact')
    expect(headerNoticeDue()).toBe(true)
  })

  it('reads a stored mode; an invalid value falls back to compact and stays "never chosen"', () => {
    localStorage.setItem(HEADER_MODE_KEY, 'hidden')
    reloadHeaderModeFromStorage()
    expect(getHeaderMode()).toBe('hidden')
    expect(headerNoticeDue()).toBe(false)
    for (const bad of ['', 'tiny', 'FULL', '{"mode":"full"}']) {
      localStorage.clear()
      localStorage.setItem(HEADER_MODE_KEY, bad)
      reloadHeaderModeFromStorage()
      expect(getHeaderMode()).toBe('compact')
      expect(headerNoticeDue()).toBe(true)
    }
  })

  it('renders compact and keeps working when storage throws (private mode)', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied') })
    reloadHeaderModeFromStorage()
    expect(getHeaderMode()).toBe('compact')
    expect(() => setHeaderMode('full')).not.toThrow()
    expect(getHeaderMode()).toBe('full') // lasts for this tab
    expect(() => markHeaderNoticed()).not.toThrow()
  })

  it('setHeaderMode persists, ignores junk, and retires the notice', () => {
    setHeaderMode('full')
    expect(localStorage.getItem(HEADER_MODE_KEY)).toBe('full')
    expect(localStorage.getItem(HEADER_NOTICE_KEY)).toBe('1')
    expect(headerNoticeDue()).toBe(false)
    setHeaderMode('sideways' as never)
    expect(getHeaderMode()).toBe('full')
    reloadHeaderModeFromStorage()
    expect(getHeaderMode()).toBe('full')
  })

  it('the notice is due once: marking it shown persists across reloads', () => {
    expect(headerNoticeDue()).toBe(true)
    markHeaderNoticed()
    expect(headerNoticeDue()).toBe(false)
    reloadHeaderModeFromStorage()
    expect(headerNoticeDue()).toBe(false)
    expect(getHeaderMode()).toBe('compact') // marking never writes a mode
    expect(localStorage.getItem(HEADER_MODE_KEY)).toBeNull()
  })

  it('toggle goes Hidden and back to the last visible mode; from a stored Hidden it returns to compact', () => {
    setHeaderMode('full')
    toggleHeaderHidden()
    expect(getHeaderMode()).toBe('hidden')
    toggleHeaderHidden()
    expect(getHeaderMode()).toBe('full')
    localStorage.setItem(HEADER_MODE_KEY, 'hidden')
    reloadHeaderModeFromStorage()
    toggleHeaderHidden()
    expect(getHeaderMode()).toBe('compact')
  })
})

describe('effectiveHeaderMode', () => {
  const base = { stored: 'compact', hydrated: true, workspaceCount: 2, touch: false } as const

  it('follows the stored mode once hydrated with a workspace', () => {
    for (const stored of ['full', 'compact', 'hidden'] as const) expect(effectiveHeaderMode({ ...base, stored })).toBe(stored)
  })

  it('is Full while booting or with no workspace, whatever is stored (the header is the only door then)', () => {
    for (const stored of ['full', 'compact', 'hidden'] as const) {
      expect(effectiveHeaderMode({ ...base, stored, hydrated: false })).toBe('full')
      expect(effectiveHeaderMode({ ...base, stored, workspaceCount: 0 })).toBe('full')
    }
  })

  it('treats Hidden as Compact without hover (touch), and leaves the others alone', () => {
    expect(effectiveHeaderMode({ ...base, stored: 'hidden', touch: true })).toBe('compact')
    expect(effectiveHeaderMode({ ...base, stored: 'full', touch: true })).toBe('full')
    expect(effectiveHeaderMode({ ...base, stored: 'compact', touch: true })).toBe('compact')
  })
})
