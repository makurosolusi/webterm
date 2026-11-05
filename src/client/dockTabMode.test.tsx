/**
 * @vitest-environment jsdom
 */
// Tab mode has no canvas viewport: zoom/fit/back/forward/lock are hidden, everything else stays.
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultTabLayout } from '../shared/tabLayout.schema'
import Dock, { type DockProps } from './Dock'
import { connectTabLayout, setMode } from './tabLayout.store'

const noop = () => {}
const props: DockProps = {
  onAddTerminal: noop, onAddAgent: noop, onCreateWorkspace: noop, onBrowse: noop,
  onUndo: noop, onRedo: noop, canUndo: false, canRedo: false,
  onBack: noop, onForward: noop, canBack: false, canForward: false,
  onFit: noop, onToggleBoard: noop, sessionsOpen: false, onToggleSessions: noop,
  inboxOpen: false, onToggleInbox: noop, zoomPct: 100, onZoomIn: noop, onZoomOut: noop, onZoomTo: noop,
  locked: false, onToggleLock: noop, cleanView: false, onToggleCleanView: noop,
}
const viewportLabels = ['Fit view', 'Zoom out', 'Zoom presets', 'Zoom in', 'Go back', 'Go forward', 'Lock view']
const keptLabels = ['Undo', 'Redo', 'Clean view', 'Add node']

beforeEach(() => connectTabLayout(defaultTabLayout(), () => {}))
afterEach(cleanup)

describe('Dock viewport controls per layout mode', () => {
  it('canvas mode shows them', () => {
    render(<Dock {...props} />)
    for (const l of viewportLabels) expect(screen.queryByLabelText(l), l).not.toBeNull()
  })

  it('tabs mode hides them but keeps the rest, and canvas mode brings them back', () => {
    render(<Dock {...props} />)
    act(() => setMode('tabs'))
    for (const l of viewportLabels) expect(screen.queryByLabelText(l), l).toBeNull()
    for (const l of keptLabels) expect(screen.queryByLabelText(l), l).not.toBeNull()
    act(() => setMode('canvas'))
    for (const l of viewportLabels) expect(screen.queryByLabelText(l), l).not.toBeNull()
  })
})
