/** @vitest-environment jsdom */
// A new download opens the node's Downloads popover by itself (no focus theft), once, and closes it after a clean finish.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '../vscode/test-setup'
import type { DownloadItem } from '../../shared/browser.downloads'
import BrowserDownloads from './BrowserDownloads'
import { AUTO_CLOSE_MS, canAutoClose, freshInProgress } from './downloadsAutoOpen'
import { DL_TEXT } from './browserDownloads.text'

beforeEach(() => vi.useFakeTimers())
afterEach(() => { cleanup(); vi.useRealTimers() })

const item = (o: Partial<DownloadItem> & { id: string }): DownloadItem => ({
  nodeId: 'n1', name: `${o.id}.zip`, url: 'https://cdn.example/f', host: 'cdn.example', received: 0, total: 100, state: 'inProgress', risky: false, startedAt: 1, ...o,
})
const done = (id: string): DownloadItem => item({ id, state: 'completed', received: 100 })

function Host({ items, hidden }: { items: DownloadItem[]; hidden?: boolean }) {
  const [open, setOpen] = useState(false)
  return <div style={hidden ? { display: 'none' } : undefined}><BrowserDownloads nodeId="n1" items={items} showButton={items.length > 0} open={open} onOpenChange={setOpen} /></div>
}
const dialog = () => screen.queryByRole('dialog', { name: 'Downloads' })
const mount = (items: DownloadItem[], hidden?: boolean) => {
  const r = render(<Host items={items} hidden={hidden} />)
  return { set: (next: DownloadItem[]) => r.rerender(<Host items={next} hidden={hidden} />) }
}
const tick = (ms: number) => act(() => { vi.advanceTimersByTime(ms) })

describe('pure rules', () => {
  it('only unknown in-progress downloads of the node are fresh', () => {
    const items = [item({ id: 'a' }), done('b'), item({ id: 'c', nodeId: 'other' }), item({ id: 'd' })]
    expect(freshInProgress(new Set(['d']), items, 'n1').map((i) => i.id)).toEqual(['a'])
  })
  it('does not auto-close while transferring or when this session had a failure', () => {
    expect(canAutoClose([item({ id: 'a' })], 'n1', new Set(['a']))).toBe(false)
    expect(canAutoClose([item({ id: 'a', state: 'failed', failure: 'network' })], 'n1', new Set(['a']))).toBe(false)
    expect(canAutoClose([item({ id: 'old', state: 'failed', failure: 'network' }), done('a')], 'n1', new Set(['a']))).toBe(true)
  })
})

describe('auto-open', () => {
  it('opens for a new download, shows its row, and does not steal focus', () => {
    const omni = document.createElement('input'); document.body.append(omni); omni.focus()
    const m = mount([])
    m.set([item({ id: 'a', received: 10 })])
    expect(dialog()).toBeTruthy()
    expect(screen.getByText('a.zip')).toBeTruthy()
    expect(document.activeElement).toBe(omni)
    omni.remove()
  })

  it('does not open for downloads that already existed at mount, nor for completed ones', () => {
    const m = mount([item({ id: 'old' })])
    expect(dialog()).toBeNull()
    m.set([item({ id: 'old', received: 50 }), done('x')])
    expect(dialog()).toBeNull()
  })

  it('does not reopen for the same download after the user closed it, but does for a new one', () => {
    const m = mount([])
    m.set([item({ id: 'a' })])
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(dialog()).toBeNull()
    m.set([item({ id: 'a', received: 60 })])
    expect(dialog()).toBeNull()
    m.set([done('a'), item({ id: 'b' })])
    expect(dialog()).toBeTruthy()
  })

  it('back-to-back downloads keep one popover', () => {
    const m = mount([])
    m.set([item({ id: 'a' })])
    m.set([item({ id: 'a' }), item({ id: 'b' })])
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(screen.getByText('b.zip')).toBeTruthy()
  })

  it('does not open in a node that is not shown', () => {
    const m = mount([], true)
    m.set([item({ id: 'a' })])
    expect(dialog()).toBeNull()
  })

  it('ignores downloads of another node', () => {
    const m = mount([])
    m.set([item({ id: 'a', nodeId: 'other' })])
    expect(dialog()).toBeNull()
  })
})

describe('auto-close', () => {
  it('closes after a clean finish, only after the delay, and a new download resets the timer', () => {
    const m = mount([])
    m.set([item({ id: 'a' })])
    m.set([done('a')])
    tick(AUTO_CLOSE_MS - 100)
    expect(dialog()).toBeTruthy()
    m.set([done('a'), item({ id: 'b' })])
    tick(AUTO_CLOSE_MS * 2)
    expect(dialog()).toBeTruthy() // b still transfers
    m.set([done('a'), done('b')])
    tick(AUTO_CLOSE_MS - 100)
    expect(dialog()).toBeTruthy()
    tick(200)
    expect(dialog()).toBeNull()
  })

  it('waits while the pointer is over it and restarts the delay when it leaves', () => {
    const m = mount([])
    m.set([item({ id: 'a' })])
    m.set([done('a')])
    fireEvent.pointerEnter(dialog()!)
    tick(AUTO_CLOSE_MS * 3)
    expect(dialog()).toBeTruthy()
    fireEvent.pointerLeave(dialog()!)
    tick(AUTO_CLOSE_MS + 10)
    expect(dialog()).toBeNull()
  })

  it('waits while focus is inside it', () => {
    const m = mount([])
    m.set([item({ id: 'a' })])
    m.set([done('a')])
    fireEvent.focus(dialog()!)
    tick(AUTO_CLOSE_MS * 3)
    expect(dialog()).toBeTruthy()
  })

  it('stays open when a download failed', () => {
    const m = mount([])
    m.set([item({ id: 'a' })])
    m.set([item({ id: 'a', state: 'failed', failure: 'network' })])
    tick(AUTO_CLOSE_MS * 5)
    expect(dialog()).toBeTruthy()
  })

  it('a popover the user opened by hand never closes by itself', () => {
    const m = mount([done('a')])
    fireEvent.click(screen.getByRole('button', { name: /^Downloads/ }))
    m.set([done('a')])
    tick(AUTO_CLOSE_MS * 5)
    expect(dialog()).toBeTruthy()
  })
})

describe('toolbar button signal', () => {
  it('shows the active label while transferring and a finished mark with an updated label after, when closed', () => {
    const m = mount([])
    m.set([item({ id: 'a' })])
    expect(screen.getByRole('button', { name: DL_TEXT.buttonActive(1) })).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    m.set([done('a')])
    expect(screen.getByRole('button', { name: DL_TEXT.buttonDone })).toBeTruthy()
    expect(document.querySelector('.bdl-done')).toBeTruthy()
    tick(5000)
    expect(screen.getByRole('button', { name: DL_TEXT.button })).toBeTruthy()
  })
})
