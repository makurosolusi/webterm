/** @vitest-environment jsdom */
// React 19 ref cleanups must survive the `@lit/react` wrappers (ui-210-2): a ref callback recreated on
// every render used to re-attach its listener each time, so one middle-click closed a session N times.
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import './test-setup'
import { Tree, TreeItem } from './register'
import { SessionTreeItem } from '../SessionRow'
import type { SessionRowVM } from '../sessionList'
import { sessionStatusView } from '../sessionStatus.model'

afterEach(cleanup)

const RENDERS = 5

describe('keepRefCleanup on the vscode-elements wrappers', () => {
  it('runs the cleanup a ref returned before the next ref call and on unmount, never ref(null)', () => {
    const calls: Array<string> = []
    const view = (n: number) => (
      <Tree><TreeItem ref={(el: Element | null) => { calls.push(el ? `set${n}` : `null${n}`); return () => { calls.push(`clean${n}`) } }} /></Tree>
    )
    const { rerender, unmount } = render(view(0))
    for (let n = 1; n <= 2; n++) rerender(view(n))
    unmount()
    expect(calls).toEqual(['set0', 'clean0', 'set1', 'clean1', 'set2', 'clean2'])
  })

  it('still assigns and clears object refs', () => {
    const ref = { current: null as Element | null }
    const { unmount } = render(<Tree><TreeItem ref={ref as never} /></Tree>)
    expect(ref.current?.tagName).toBe('VSCODE-TREE-ITEM')
    unmount()
    expect(ref.current).toBeNull()
  })
})

describe('SessionTreeItem middle-click', () => {
  const row: SessionRowVM = { id: 's1', label: 'shell', title: 'shell', kind: 'terminal', view: sessionStatusView({}), projectId: 'w1', projectName: 'W' }

  it('closes the session exactly once after many re-renders', () => {
    const onClose = vi.fn()
    const view = () => <Tree><SessionTreeItem row={row} mode="project" now={0} onCloseSession={onClose} onMoreActions={() => {}} register={() => {}} /></Tree>
    const { rerender, container } = render(view())
    for (let i = 0; i < RENDERS; i++) rerender(view())
    container.querySelector('vscode-tree-item')!.dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true }))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledWith('s1')
  })
})
