/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useBrowserContextMenu } from './useBrowserContextMenu'

const send = vi.fn()
const nav = vi.fn()
let feed: (m: { t: string }) => boolean = () => false

function Harness() {
  const bodyRef = useRef<HTMLDivElement>(null)
  const m = useBrowserContextMenu({ bodyRef, send, nav, canBack: true, canForward: false, notify: vi.fn() })
  feed = m.onMsg
  return <><div ref={bodyRef} data-testid="body" />{m.menu}</>
}

afterEach(() => { cleanup(); send.mockReset(); nav.mockReset() })

describe('page context menu', () => {
  it('ignores other messages and opens an accessible menu for a contextMenu message', () => {
    render(<Harness />)
    expect(feed({ t: 'state' })).toBe(false)
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.pointerDown(screen.getByTestId('body'), { button: 2, clientX: 30, clientY: 40 })
    act(() => { expect(feed({ t: 'contextMenu', id: 'n1', link: { href: 'https://l.test/a', text: 'a' }, selection: false, editable: false } as never)).toBe(true) })
    expect(screen.getByRole('menu', { name: 'Page actions' })).toBeTruthy()
    expect(screen.getAllByRole('menuitem').map((i) => i.textContent)).toEqual(expect.arrayContaining(['Open link in new tab', 'Copy link address', 'Back', 'Reload']))
  })

  it('"Open link in new tab" sends openLink for the pane that was clicked, then closes; Escape closes too', () => {
    render(<Harness />)
    act(() => { feed({ t: 'contextMenu', id: 'n1', tab: 'tb1', link: { href: 'https://l.test/a', text: 'a' }, selection: false, editable: false } as never) })
    fireEvent.click(screen.getByRole('menuitem', { name: /Open link in new tab/ }))
    expect(send).toHaveBeenCalledWith({ t: 'openLink', url: 'https://l.test/a', tab: 'tb1' })
    expect(screen.queryByRole('menu')).toBeNull()
    act(() => { feed({ t: 'contextMenu', id: 'n1', selection: false, editable: false } as never) })
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
  })
})
