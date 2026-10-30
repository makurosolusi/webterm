import { describe, expect, it, vi } from 'vitest'
import { canClaimFocus, exitMessage, openLinkOnModifiedClick } from './terminalSession'

const el = (tagName: string, cls: string[] = [], isContentEditable = false) => ({
  tagName,
  classList: { contains: (c: string) => cls.includes(c) },
  isContentEditable,
})

describe('exitMessage', () => {
  it('includes the exit code', () => {
    expect(exitMessage(0)).toBe('\r\n[process exited with code 0]')
    expect(exitMessage(130)).toBe('\r\n[process exited with code 130]')
  })
})

describe('canClaimFocus', () => {
  it('claims when nothing or a non-editable element is focused', () => {
    expect(canClaimFocus(null, false)).toBe(true)
    expect(canClaimFocus(el('BODY'), false)).toBe(true)
    expect(canClaimFocus(el('BUTTON'), false)).toBe(true)
  })
  it('never steals from inputs, selects or contenteditable', () => {
    expect(canClaimFocus(el('INPUT'), true)).toBe(false)
    expect(canClaimFocus(el('TEXTAREA'), true)).toBe(false)
    expect(canClaimFocus(el('SELECT'), false)).toBe(false)
    expect(canClaimFocus(el('DIV', [], true), true)).toBe(false)
  })
  it('takes over another terminal only on user selection, not on mount', () => {
    const helper = el('TEXTAREA', ['xterm-helper-textarea'])
    expect(canClaimFocus(helper, true)).toBe(true)
    expect(canClaimFocus(helper, false)).toBe(false)
  })
})

describe('openLinkOnModifiedClick', () => {
  it('opens with Cmd or Ctrl held', () => {
    const open = vi.fn()
    openLinkOnModifiedClick({ metaKey: true, ctrlKey: false }, 'https://a.test', open)
    openLinkOnModifiedClick({ metaKey: false, ctrlKey: true }, 'https://b.test', open)
    expect(open.mock.calls).toEqual([['https://a.test'], ['https://b.test']])
  })
  it('ignores a plain click', () => {
    const open = vi.fn()
    openLinkOnModifiedClick({ metaKey: false, ctrlKey: false }, 'https://a.test', open)
    expect(open).not.toHaveBeenCalled()
  })
  it('default opener uses a new tab with noopener', () => {
    const w = vi.fn()
    vi.stubGlobal('window', { open: w })
    openLinkOnModifiedClick({ metaKey: true, ctrlKey: false }, 'https://a.test')
    vi.unstubAllGlobals()
    expect(w).toHaveBeenCalledWith('https://a.test', '_blank', 'noopener')
  })
})
