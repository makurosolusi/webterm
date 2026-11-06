/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import BottomPanelHost, { revealBottomView, type BottomPanelView } from './bottomPanelHost'
import { setTimelineOpen, toggleTimeline, useTimelineView } from './Timeline'
import { useState } from 'react'

vi.mock('./Timeline.stream', () => ({
  useTimelineFeed: () => ({ events: [], epoch: 0, connection: 'open', error: null, more: false, loadingOlder: false, loadOlder: async () => undefined }),
}))
vi.mock('./Timeline.status', async (orig) => ({
  ...(await orig<typeof import('./Timeline.status')>()),
  useTimelineStatus: () => ({ control: null, integrity: { state: 'unknown' } }),
}))

/** The app's wiring in miniature: Chat (plain view) next to the real Activity view. */
function Harness() {
  const [chatOpen, setChatOpen] = useState(true)
  const activity = useTimelineView({ workspaces: [], onFocusNode: () => undefined })
  const views: BottomPanelView[] = [
    { id: 'chat', label: 'Chat', open: chatOpen, onClose: () => setChatOpen(false), render: () => <p>chat body</p> },
    activity,
  ]
  return <BottomPanelHost views={views} />
}

const visiblePanes = () => [...document.querySelectorAll('.vscode-bottom-panel__pane')].filter((el) => !el.hasAttribute('hidden'))
const tabs = () => within(screen.getByRole('tablist', { name: 'Panel tabs' })).getAllByRole('tab')

beforeEach(() => { localStorage.clear(); setTimelineOpen(false); revealBottomView(null) })
afterEach(() => { cleanup(); localStorage.clear() })

describe('Activity as a bottom panel view', () => {
  it('opening Activity while Chat is open yields ONE host with both tabs and Activity shown', () => {
    render(<Harness />)
    act(() => toggleTimeline())
    expect(document.querySelectorAll('.bottom-panel-host')).toHaveLength(1)
    expect(document.querySelector('.timeline-panel-host')).toBeNull()
    expect(tabs().map((t) => t.textContent)).toEqual([expect.stringMatching(/^Chat/), expect.stringMatching(/^Activity/)])
    expect(visiblePanes()).toHaveLength(1)
    expect(within(visiblePanes()[0] as HTMLElement).getByLabelText('Activity timeline')).not.toBeNull()
    expect(screen.getByText('chat body').closest('.vscode-bottom-panel__pane')?.hasAttribute('hidden')).toBe(true)
  })

  it('toggling Activity while it is shown closes it', () => {
    render(<Harness />)
    act(() => toggleTimeline())
    act(() => toggleTimeline())
    expect(tabs().map((t) => t.textContent)).toEqual([expect.stringMatching(/^Chat/)])
    expect(localStorage.getItem('webterm.timelineOpen')).toBe('0')
  })

  it('toggling Activity while hidden behind another tab reveals it without closing', () => {
    render(<Harness />)
    act(() => toggleTimeline())
    fireEvent.click(screen.getByRole('tab', { name: /^Chat/ }))
    expect(screen.getByText('chat body').closest('.vscode-bottom-panel__pane')?.hasAttribute('hidden')).toBe(false)
    act(() => toggleTimeline())
    expect(tabs()).toHaveLength(2)
    expect(within(visiblePanes()[0] as HTMLElement).getByLabelText('Activity timeline')).not.toBeNull()
  })
})
