/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ANNOUNCE_GAP_MS, CentralActTray, type CentralActTrayProps } from './CentralActTray'
import type { ActEntry } from './centralAct.store'

const rowText = (): string | null | undefined => document.querySelector('.central-act-tray__text')?.textContent
const entry = (nodeId: string, over: Partial<ActEntry> = {}): ActEntry => ({ nodeId, verb: 'typed', tool: 'canvas.type', n: 1, ts: 0, seq: 1, ...over })
const props = (over: Partial<CentralActTrayProps> = {}): CentralActTrayProps => ({
  entries: [], dropped: 0, activeWorkspaceId: 'w1', nodeTitle: (id) => (id === 'a' || id === 'b' ? `Node ${id}` : undefined), boardName: (id) => (id === 'w2' ? 'Backend' : undefined),
  follow: { on: true, status: 'following', resumeInS: 0, heldNodeId: null, more: 0 }, onToggleFollow: vi.fn(), onShow: vi.fn(), onOpenBoard: vi.fn(), ...over,
})

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('CentralActTray', () => {
  it('keeps a polite live region mounted while idle and never uses assertive', () => {
    const { container } = render(<CentralActTray {...props()} />)
    const live = screen.getByRole('status')
    expect(live.getAttribute('aria-live')).toBe('polite')
    expect(live.textContent).toBe('')
    expect(container.querySelector('[aria-live="assertive"], [role="alert"]')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('announces at most once per ANNOUNCE_GAP_MS, then the latest sentence', () => {
    const { rerender } = render(<CentralActTray {...props({ entries: [entry('a')] })} />)
    expect(screen.getByRole('status').textContent).toBe('Central typed Node a')
    rerender(<CentralActTray {...props({ entries: [entry('b', { verb: 'drove' }), entry('a')] })} />)
    expect(screen.getByRole('status').textContent).toBe('Central typed Node a') // held back
    act(() => { vi.advanceTimersByTime(ANNOUNCE_GAP_MS - 1) })
    expect(screen.getByRole('status').textContent).toBe('Central typed Node a')
    act(() => { vi.advanceTimersByTime(1) })
    expect(screen.getByRole('status').textContent).toBe('Central drove Node b')
  })

  it('shows the merged count and "N more" (hidden and evicted nodes both count), and Show calls onShow with the node', () => {
    const p = props({ entries: [entry('a', { n: 3 }), entry('b')], dropped: 4 })
    render(<CentralActTray {...p} />)
    expect(rowText()).toBe('Central typed Node a (3 actions)')
    expect(screen.getByText('5 more')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Show' }))
    expect(p.onShow).toHaveBeenCalledWith('a')
  })

  it('a node on another board says "in <board>" with an Open button that switches the board, not the camera', () => {
    const p = props({ entries: [entry('x', { workspaceId: 'w2' })] })
    render(<CentralActTray {...p} />)
    expect(rowText()).toBe('Central typed a node in Backend')
    expect(screen.queryByRole('button', { name: 'Show' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(p.onOpenBoard).toHaveBeenCalledWith('w2')
    expect(p.onShow).not.toHaveBeenCalled()
  })

  it('a node that is gone reads "Node closed" with a disabled button', () => {
    const p = props({ entries: [entry('gone', { workspaceId: 'w1' })] })
    render(<CentralActTray {...p} />)
    expect(screen.getAllByText('Node closed').length).toBeGreaterThan(0)
    const btn = screen.getByRole('button', { name: 'Show' }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    fireEvent.click(btn)
    expect(p.onShow).not.toHaveBeenCalled()
  })

  it('returns to idle when the entries expire: the row goes, the live region stays', () => {
    const { rerender } = render(<CentralActTray {...props({ entries: [entry('a')] })} />)
    rerender(<CentralActTray {...props()} />)
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByRole('status').textContent).toBe('')
  })

  it('the Follow switch shows the status and toggles; paused shows the countdown, spoken once without it', () => {
    const on = props({ entries: [entry('a')] })
    const { rerender } = render(<CentralActTray {...on} />)
    fireEvent.click(screen.getByRole('button', { name: 'Following Central' }))
    expect(on.onToggleFollow).toHaveBeenCalledTimes(1)
    const paused = props({ entries: [entry('a')], follow: { on: true, status: 'paused', resumeInS: 7, heldNodeId: null, more: 0 } })
    rerender(<CentralActTray {...paused} />)
    expect(screen.getByRole('button', { name: /Paused \(you moved the canvas\) · resumes in 7s/ })).toBeTruthy()
    const spoken = (): string => document.querySelector('.central-act-tray__live--follow')?.textContent ?? ''
    expect(spoken()).toBe('Following Central') // held back by the 3 s gap
    act(() => { vi.advanceTimersByTime(ANNOUNCE_GAP_MS) })
    expect(spoken()).toBe('Follow paused')
    rerender(<CentralActTray {...props({ entries: [entry('a')], follow: { ...paused.follow, resumeInS: 3 } })} />)
    act(() => { vi.advanceTimersByTime(ANNOUNCE_GAP_MS) })
    expect(spoken()).toBe('Follow paused') // the countdown is never spoken
  })

  it('held says "acted on" with Show, and Off stays reachable while idle', () => {
    const held = props({ entries: [entry('a')], follow: { on: true, status: 'held', resumeInS: 0, heldNodeId: 'a', more: 0 } })
    const { rerender } = render(<CentralActTray {...held} />)
    expect(rowText()).toBe('Central acted on Node a')
    expect(screen.getByRole('button', { name: 'Show' })).toBeTruthy()
    rerender(<CentralActTray {...props({ follow: { on: false, status: 'off', resumeInS: 0, heldNodeId: null, more: 0 } })} />)
    expect(screen.getByRole('button', { name: 'Follow off' })).toBeTruthy()
  })
})
