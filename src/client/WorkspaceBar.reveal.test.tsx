/** @vitest-environment jsdom */
// Hidden header: the real reveal hook driving the real tab row. A push at the top edge reveals the row, the pointer
// inside it (or inside a menu opened from it) keeps it, leaving hides it again.
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import './vscode/test-setup'
import WorkspaceBar from './WorkspaceBar'
import { REVEAL_DWELL_MS, REVEAL_EDGE_PX, REVEAL_HIDE_MS, useHeaderReveal } from './useHeaderReveal'
import { DEFAULT_VIEWPORT, type Workspace } from '../shared/workspace'

const ws: Workspace = { id: 'w1', name: 'Proj', cwd: '/proj', viewport: DEFAULT_VIEWPORT, nodes: [], bridges: [], updatedAt: 0 } // test-only

function Harness() {
  const revealed = useHeaderReveal(true)
  return (
    <WorkspaceBar workspaces={[ws]} activeId="w1" liveActiveNodes={[]} statuses={{}} headerMode="hidden" revealed={revealed}
      onSelect={vi.fn()} onNewWorkspace={vi.fn()} onRenameWorkspace={vi.fn()} onDeleteWorkspace={vi.fn()} railChrome />
  )
}
const move = (clientY: number, over: Element = document.body): void => { act(() => { over.dispatchEvent(new MouseEvent('pointermove', { clientY, bubbles: true })) }) }
const tick = (ms: number): void => { act(() => { vi.advanceTimersByTime(ms) }) }

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ managed: false }))))
  vi.useFakeTimers()
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })

describe('Hidden auto-reveal', () => {
  it('a push at the top edge reveals the tab row; the pointer inside keeps it; leaving hides it again', () => {
    const { container } = render(<Harness />)
    const row = container.querySelector('.app-tabs') as HTMLElement
    expect(row.getAttribute('data-revealed')).toBe('false')
    move(REVEAL_EDGE_PX)
    tick(REVEAL_DWELL_MS)
    expect(row.getAttribute('data-revealed')).toBe('true')
    move(20, row) // inside the row: stays
    tick(REVEAL_HIDE_MS * 2)
    expect(row.getAttribute('data-revealed')).toBe('true')
    move(300) // out over the canvas
    tick(REVEAL_HIDE_MS)
    expect(row.getAttribute('data-revealed')).toBe('false')
  })

  it('stays hidden while the pointer is only near, not at, the edge', () => {
    const { container } = render(<Harness />)
    move(REVEAL_EDGE_PX + 5)
    tick(REVEAL_DWELL_MS * 3)
    expect((container.querySelector('.app-tabs') as HTMLElement).getAttribute('data-revealed')).toBe('false')
  })
})
