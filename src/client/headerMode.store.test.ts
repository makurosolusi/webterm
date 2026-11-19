/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_HEADER_MODE, HEADER_MODES, HEADER_MODE_KEY, HEADER_NOTICE_KEY, effectiveHeaderMode, getHeaderMode, headerNoticeDue, markHeaderNoticed,
  reloadHeaderModeFromStorage, setHeaderMode, toggleHeaderHidden,
} from './headerMode.store'

beforeEach(() => {
  localStorage.clear()
  reloadHeaderModeFromStorage()
})
afterEach(() => vi.restoreAllMocks())

describe('header mode store', () => {
  it('has exactly two modes, Tabs by default, and nothing to announce when nothing is stored', () => {
    expect([...HEADER_MODES]).toEqual(['tabs', 'hidden'])
    expect(DEFAULT_HEADER_MODE).toBe('tabs')
    expect(getHeaderMode()).toBe('tabs')
    expect(headerNoticeDue()).toBe(false)
  })

  it('reads a stored mode; an invalid value falls back to Tabs without a notice', () => {
    localStorage.setItem(HEADER_MODE_KEY, 'hidden')
    reloadHeaderModeFromStorage()
    expect(getHeaderMode()).toBe('hidden')
    for (const bad of ['', 'tiny', 'FULL', '{"mode":"full"}']) {
      localStorage.clear()
      localStorage.setItem(HEADER_MODE_KEY, bad)
      reloadHeaderModeFromStorage()
      expect(getHeaderMode()).toBe('tabs')
      expect(headerNoticeDue()).toBe(false)
    }
  })

  it('migrates a stored full / compact to tabs, keeps hidden, and the notice is due for the migrated ones only', () => {
    for (const legacy of ['full', 'compact']) {
      localStorage.clear()
      localStorage.setItem(HEADER_MODE_KEY, legacy)
      reloadHeaderModeFromStorage()
      expect(getHeaderMode()).toBe('tabs')
      expect(headerNoticeDue()).toBe(true)
    }
    localStorage.clear()
    localStorage.setItem(HEADER_MODE_KEY, 'hidden')
    reloadHeaderModeFromStorage()
    expect(getHeaderMode()).toBe('hidden')
    expect(headerNoticeDue()).toBe(false)
  })

  it('the notice is one-shot: marking it rewrites the stored value to the new name and it never returns', () => {
    localStorage.setItem(HEADER_MODE_KEY, 'compact')
    reloadHeaderModeFromStorage()
    markHeaderNoticed()
    expect(headerNoticeDue()).toBe(false)
    expect(localStorage.getItem(HEADER_MODE_KEY)).toBe('tabs')
    expect(localStorage.getItem(HEADER_NOTICE_KEY)).toBe('1')
    reloadHeaderModeFromStorage()
    expect(headerNoticeDue()).toBe(false)
    expect(getHeaderMode()).toBe('tabs')
  })

  it('an explicit choice retires a pending notice and persists', () => {
    localStorage.setItem(HEADER_MODE_KEY, 'full')
    reloadHeaderModeFromStorage()
    setHeaderMode('hidden')
    expect(headerNoticeDue()).toBe(false)
    expect(localStorage.getItem(HEADER_MODE_KEY)).toBe('hidden')
    setHeaderMode('sideways' as never)
    expect(getHeaderMode()).toBe('hidden')
    reloadHeaderModeFromStorage()
    expect(getHeaderMode()).toBe('hidden')
  })

  it('renders tabs and keeps working when storage throws (private mode)', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied') })
    reloadHeaderModeFromStorage()
    expect(getHeaderMode()).toBe('tabs')
    expect(() => setHeaderMode('hidden')).not.toThrow()
    expect(getHeaderMode()).toBe('hidden') // lasts for this tab
    expect(() => markHeaderNoticed()).not.toThrow()
  })

  it('toggle swaps Hidden and Tabs', () => {
    toggleHeaderHidden()
    expect(getHeaderMode()).toBe('hidden')
    toggleHeaderHidden()
    expect(getHeaderMode()).toBe('tabs')
  })
})

describe('effectiveHeaderMode', () => {
  const base = { stored: 'tabs', hydrated: true, workspaceCount: 2, touch: false } as const

  it('follows the stored mode once hydrated with a workspace', () => {
    for (const stored of HEADER_MODES) expect(effectiveHeaderMode({ ...base, stored })).toBe(stored)
  })

  it('is Tabs while booting or with no workspace, whatever is stored (the row is the only door then)', () => {
    for (const stored of HEADER_MODES) {
      expect(effectiveHeaderMode({ ...base, stored, hydrated: false })).toBe('tabs')
      expect(effectiveHeaderMode({ ...base, stored, workspaceCount: 0 })).toBe('tabs')
    }
  })

  it('treats Hidden as Tabs without hover (touch), and leaves Tabs alone', () => {
    expect(effectiveHeaderMode({ ...base, stored: 'hidden', touch: true })).toBe('tabs')
    expect(effectiveHeaderMode({ ...base, stored: 'tabs', touch: true })).toBe('tabs')
  })
})
