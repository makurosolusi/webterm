/** @vitest-environment jsdom */
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import NodeChrome from './NodeChrome'

afterEach(cleanup)

const base = {
  title: 'brisk-otter', onRename: () => {}, collapsed: false, onToggleCollapse: () => {},
  color: '#0a84ff', onColor: () => {}, comments: [], onAddComment: () => {}, onRefresh: () => {},
  searchOpen: false, onToggleSearch: () => {}, maximized: false, onToggleMaximize: () => {}, onClose: () => {},
}

describe('node identity in the chrome', () => {
  it('shows a Stop button only when wired, and it calls onStop (not onClose)', () => {
    const a = render(<NodeChrome {...base} />)
    expect(a.container.querySelector('[data-title="Stop agent"]')).toBeNull()
    a.unmount()
    const onStop = vi.fn(); const onClose = vi.fn()
    const b = render(<NodeChrome {...base} onStop={onStop} onClose={onClose} />)
    fireEvent.click(b.container.querySelector('[data-title="Stop agent"]') as Element)
    expect(onStop).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('renders the identity color chip next to the title', () => {
    const { container } = render(<NodeChrome {...base} identityColor="hsl(10, 65%, 55%)" />)
    const chip = container.querySelector('.node-identity') as HTMLElement
    expect(chip.style.background).toBe('rgb(215, 91, 66)') // jsdom normalises hsl(10, 65%, 55%)
  })
})
