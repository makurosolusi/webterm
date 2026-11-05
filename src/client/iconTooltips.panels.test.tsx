/**
 * @vitest-environment jsdom
 */
// Tab strips and breadcrumbs migrated from native `title` to IconTooltip: the hint is a real
// tooltip on hover/focus, and the icon-only close buttons keep their accessible name.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { BottomPanelTabs } from './bottomPanelTabs'
import { VscodeBreadcrumbs } from './components/vscode/vscodeBreadcrumbs'
import { VscodeEditorTabBar } from './components/vscode/vscodeEditorTabBar'

const noop = () => {}
const tipOf = (el: Element): string | null | undefined => {
  fireEvent.keyDown(document, { key: 'Tab' }) // keyboard navigation: focus alone does not open a tooltip
  fireEvent.focus(el)
  const text = document.querySelector('[role="tooltip"]')?.textContent
  fireEvent.blur(el)
  return text
}

afterEach(cleanup)

describe('tab and breadcrumb tooltips', () => {
  it('bottom panel tabs: tab hint and close button tooltip, no native title', () => {
    render(<BottomPanelTabs ariaLabel="Panel" activeId="out" onActivate={noop} onClose={noop}
      tabs={[{ id: 'out', label: 'Output', tooltip: 'Output (agent logs)' }]} />)
    const tab = screen.getByRole('tab', { name: 'Output' })
    expect(tab.hasAttribute('title')).toBe(false)
    expect(tipOf(tab)).toBe('Output (agent logs)')
    const close = screen.getByRole('button', { name: 'Close Output' })
    expect(close.hasAttribute('title')).toBe(false)
    expect(tipOf(close)).toBe('Close Output')
  })

  it('editor tabs: tab tooltip falls back to the label; close button says what it closes', () => {
    render(<VscodeEditorTabBar activeId="a" onActivate={noop} onClose={noop} tabs={[{ id: 'a', label: 'a.ts' }]} />)
    expect(tipOf(screen.getByRole('tab', { name: 'a.ts' }))).toBe('a.ts')
    expect(tipOf(screen.getByRole('button', { name: 'Close a.ts' }))).toBe('Close a.ts')
  })

  it('breadcrumbs: segment and overflow trigger show their hint', () => {
    render(<VscodeBreadcrumbs maxVisible={1} onSelect={noop}
      segments={[{ id: 'src', label: 'src' }, { id: 'a', label: 'a.ts', title: '/w/src/a.ts' }]} />)
    const seg = screen.getByRole('button', { name: 'a.ts' })
    expect(seg.hasAttribute('title')).toBe(false)
    expect(tipOf(seg)).toBe('/w/src/a.ts')
    expect(tipOf(screen.getByRole('button', { name: 'Show hidden path segments' }))).toBe('Show hidden path segments')
  })
})
