/** @vitest-environment jsdom */
// Unsaved tab (VS Code): a node that publishes `dirty` gets a dot in place of its tab's ×, the ×
// comes back on hover/focus, and the tab's accessible name says "Unsaved changes".
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import './vscode/test-setup'
import TabNodeActions, { useDirtyTabs } from './tabLayout.nodeActions'
import TabStrip, { type TabItem } from './tabLayout.strip'

afterEach(cleanup)

const ITEMS: TabItem[] = [{ id: 'e1', title: 'note.md', icon: 'file' }, { id: 't1', title: 'Terminal', icon: 'terminal' }]
const strip = (items: TabItem[], onClose = vi.fn()) => (
  <TabStrip items={items} active="e1" onActivate={() => {}} onClose={onClose} onRename={() => {}} onReorder={() => {}} />
)

describe('tab strip dirty dot', () => {
  it('shows the dot on a dirty tab, keeps the × to close it, and names the tab unsaved', () => {
    const onClose = vi.fn()
    render(strip([{ ...ITEMS[0], dirty: true }, ITEMS[1]], onClose))
    const dirty = screen.getByRole('tab', { name: /note\.md/ })
    expect(dirty.classList.contains('tabs-tab--dirty')).toBe(true)
    expect(dirty.getAttribute('aria-selected')).toBe('true')
    expect(within(dirty).getByRole('img', { name: 'Unsaved changes' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: /note\.md.*Unsaved changes/ })).toBe(dirty)
    fireEvent.click(within(dirty).getByRole('button', { name: 'Close note.md' }))
    expect(onClose).toHaveBeenCalledWith('e1')

    const clean = screen.getByRole('tab', { name: /Terminal/ })
    expect(clean.classList.contains('tabs-tab--dirty')).toBe(false)
    expect(within(clean).queryByRole('img', { name: 'Unsaved changes' })).toBeNull()
  })

  it('CSS: the dot hides the × on a dirty tab (even active) until hover or focus', () => {
    const css = readFileSync(join(__dirname, 'tab-layout.css'), 'utf8')
    const rule = (sel: string) => new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^{]*\\{([^}]*)\\}`).exec(css)?.[1] ?? ''
    // After the active-tab rule, so the dot wins on the active tab.
    expect(css.indexOf('.tabs-tab--dirty .tabs-tab__close {')).toBeGreaterThan(css.indexOf('.tabs-tab--active .tabs-tab__close'))
    expect(rule('.tabs-tab--dirty .tabs-tab__close')).toMatch(/opacity:\s*0/)
    expect(css).toMatch(/\.tabs-tab--dirty:hover \.tabs-tab__close, \.tabs-tab--dirty:focus-within \.tabs-tab__close \{ opacity: 1; \}/)
    expect(css).toMatch(/\.tabs-tab--dirty:hover \.tabs-tab__dirty, \.tabs-tab--dirty:focus-within \.tabs-tab__dirty \{ visibility: hidden; \}/)
  })

  it('a node publishing dirty marks its tab; clearing or unmounting removes the mark', () => {
    let setDirty!: (d: boolean) => void
    let setMounted!: (m: boolean) => void
    function Board() {
      const [dirty, sd] = useState(false)
      const [mounted, sm] = useState(true)
      setDirty = sd
      setMounted = sm
      const marked = useDirtyTabs()
      return (
        <>
          {strip(ITEMS.map((t) => ({ ...t, dirty: marked.has(t.id) })))}
          {mounted && <TabNodeActions id="e1" visible={false} items={[]} dirty={dirty} />}
        </>
      )
    }
    render(<Board />)
    const unsaved = () => screen.queryByRole('img', { name: 'Unsaved changes' })
    expect(unsaved()).toBeNull()
    act(() => setDirty(true))
    expect(within(screen.getByRole('tab', { name: /note\.md/ })).getByRole('img', { name: 'Unsaved changes' })).toBeTruthy()
    act(() => setDirty(false))
    expect(unsaved()).toBeNull()
    act(() => setDirty(true))
    act(() => setMounted(false))
    expect(unsaved()).toBeNull()
  })
})
