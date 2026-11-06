/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ChatComposer, { stepHistory } from './chatComposer'

afterEach(cleanup)

/** Visible tooltip of `el` (focus opens it); the label is the tooltip, not a native `title`. */
const tipOf = (el: Element): string | null => {
  fireEvent.focus(el)
  const text = document.querySelector('[role="tooltip"]')?.textContent ?? null
  fireEvent.blur(el)
  return text
}
const box = (): HTMLTextAreaElement => screen.getByLabelText('Message the central agent') as HTMLTextAreaElement

function type(text: string): void {
  fireEvent.change(box(), { target: { value: text } })
}

describe('stepHistory', () => {
  it('walks back to the oldest entry, then forward to the draft', () => {
    expect(stepHistory(0, null, -1)).toBeNull()
    expect(stepHistory(3, null, -1)).toBe(2)
    expect(stepHistory(3, 0, -1)).toBe(0)
    expect(stepHistory(3, 1, 1)).toBe(2)
    expect(stepHistory(3, 2, 1)).toBeNull()
    expect(stepHistory(3, null, 1)).toBeNull()
  })
})

describe('ChatComposer', () => {
  it('sends on Enter, keeps a newline on Shift+Enter and ignores IME composition', () => {
    const onSend = vi.fn()
    render(<ChatComposer busy={false} onSend={onSend} onStop={() => {}} />)
    type('hello')
    fireEvent.keyDown(box(), { key: 'Enter', shiftKey: true })
    expect(onSend).not.toHaveBeenCalled()
    fireEvent.keyDown(box(), { key: 'Enter', isComposing: true })
    expect(onSend).not.toHaveBeenCalled()
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('hello', [])
    expect(box().value).toBe('')
  })

  it('recalls sent messages with ArrowUp at the start and restores the draft with ArrowDown', () => {
    render(<ChatComposer busy={false} onSend={() => {}} onStop={() => {}} />)
    type('first')
    fireEvent.keyDown(box(), { key: 'Enter' })
    type('second')
    fireEvent.keyDown(box(), { key: 'Enter' })
    type('draft')
    box().setSelectionRange(0, 0)
    fireEvent.keyDown(box(), { key: 'ArrowUp' })
    expect(box().value).toBe('second')
    box().setSelectionRange(0, 0)
    fireEvent.keyDown(box(), { key: 'ArrowUp' })
    expect(box().value).toBe('first')
    box().setSelectionRange(box().value.length, box().value.length)
    fireEvent.keyDown(box(), { key: 'ArrowDown' })
    fireEvent.keyDown(box(), { key: 'ArrowDown' })
    expect(box().value).toBe('draft')
  })

  it('does not hijack ArrowUp while the caret is past the first character', () => {
    render(<ChatComposer busy={false} onSend={() => {}} onStop={() => {}} />)
    type('first')
    fireEvent.keyDown(box(), { key: 'Enter' })
    type('abc')
    box().setSelectionRange(2, 2)
    fireEvent.keyDown(box(), { key: 'ArrowUp' })
    expect(box().value).toBe('abc')
  })

  it('shows Ask placeholder, Send disabled when empty, and Stop while a turn runs', () => {
    const onStop = vi.fn()
    const { rerender } = render(<ChatComposer busy={false} onSend={() => {}} onStop={onStop} />)
    expect(box().placeholder).toMatch(/^Ask /)
    const send = screen.getByLabelText('Send message') as HTMLButtonElement
    expect(send.disabled).toBe(true)
    expect(send.hasAttribute('title')).toBe(false)
    expect(tipOf(send.parentElement!)).toBe('Send message (type a message first) Enter')
    rerender(<ChatComposer busy onSend={() => {}} onStop={onStop} />)
    expect(screen.queryByLabelText('Send message')).toBeNull()
    fireEvent.click(screen.getByLabelText('Stop turn'))
    expect(onStop).toHaveBeenCalledTimes(1)
    expect(tipOf(screen.getByLabelText('Stop turn'))).toBe('Stop the running turn')
    expect(screen.getByLabelText('Stop turn').querySelector('.codicon-debug-stop')).not.toBeNull()
  })

  it('without `completion` it stays a plain textarea: no menu on "/" or "@", Enter sends', () => {
    const onSend = vi.fn()
    render(<ChatComposer busy={false} onSend={onSend} onStop={() => {}} />)
    type('/help')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(box().hasAttribute('role')).toBe(false)
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('/help', [])
    type('@src')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('Escape stops a running turn, and does nothing when idle', () => {
    const onStop = vi.fn()
    const { rerender } = render(<ChatComposer busy={false} onSend={() => {}} onStop={onStop} />)
    fireEvent.keyDown(box(), { key: 'Escape' })
    expect(onStop).not.toHaveBeenCalled()
    rerender(<ChatComposer busy onSend={() => {}} onStop={onStop} />)
    fireEvent.keyDown(box(), { key: 'Escape' })
    expect(onStop).toHaveBeenCalledTimes(1)
  })
})
