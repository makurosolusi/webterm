/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ChatMarkdown from './chatMarkdown'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('ChatMarkdown code blocks', () => {
  it('adds a language header and a Copy button to fenced code', () => {
    const { container } = render(<ChatMarkdown source={'```ts\nconst a = 1\n```'} />)
    expect(container.querySelector('.chat-code__lang')?.textContent).toBe('ts')
    expect(screen.getByRole('button', { name: 'Copy code' }).querySelector('.codicon-copy')).not.toBeNull()
    expect(container.querySelector('.chat-code > pre')?.textContent).toContain('const a = 1')
  })

  it('does not wrap a block twice when the source rerenders unchanged', () => {
    const { container, rerender } = render(<ChatMarkdown source={'```\nx\n```'} />)
    rerender(<ChatMarkdown source={'```\nx\n```'} />)
    expect(container.querySelectorAll('.chat-code')).toHaveLength(1)
  })

  it('copies only the code text and flips the icon to a check', async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    render(<ChatMarkdown source={'```js\nlet z = 2\n```'} />)
    const button = screen.getByRole('button', { name: 'Copy code' })
    fireEvent.click(button)
    await waitFor(() => expect(button.querySelector('.codicon-check')).not.toBeNull())
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('let z = 2'))
    const copied = (writeText.mock.calls[0] as unknown as [string])[0]
    expect(copied).not.toContain('js')
  })

  it('renders links and inline code without a code header', () => {
    const { container } = render(<ChatMarkdown source={'see `x` and [docs](https://example.com)'} />)
    expect(container.querySelector('.chat-code')).toBeNull()
    expect(container.querySelector('a')?.textContent).toBe('docs')
  })
})

describe('ChatMarkdown links', () => {
  it('a web link never opens a machine-browser tab by itself and never navigates webterm (no browser node here)', () => {
    const open = vi.fn(() => null)
    vi.stubGlobal('open', open)
    const { container } = render(<ChatMarkdown source={'[docs](https://example.com) [rel](src/a.ts)'} />)
    const web = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
    container.querySelector('a[href^="https"]')!.dispatchEvent(web)
    expect(web.defaultPrevented).toBe(true)
    // The canvas link notice offers the explicit exit; nothing opens on its own.
    expect(open).not.toHaveBeenCalled()
    // A relative path has no folder in chat: kept off the tab, nothing opened.
    const rel = new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 })
    container.querySelector('a[href="src/a.ts"]')!.dispatchEvent(rel)
    expect(rel.defaultPrevented).toBe(true)
    expect(open).not.toHaveBeenCalled()
  })
})
