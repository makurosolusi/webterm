/**
 * @vitest-environment jsdom
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VscodeActivityBar } from './vscodeActivityBar'
import { VscodeBreadcrumbs } from './vscodeBreadcrumbs'
import { VscodeEditorTabBar } from './vscodeEditorTabBar'
import { VscodeMenuBar } from './vscodeMenuBar'
import { VscodeSplitView } from './vscodeSplitView'
import { VscodeStatusBar } from './vscodeStatusBar'

afterEach(cleanup)

// jsdom rewrites `import.meta.url` to an http URL, so resolve from cwd. Vitest's
// root is `src/client`, while npm scripts run from the repo root; accept both.
const cssPath = [
  path.resolve(process.cwd(), 'src/client/components/vscode/vscode-shell.css'),
  path.resolve(process.cwd(), 'components/vscode/vscode-shell.css'),
].find(existsSync)
if (!cssPath) throw new Error('vscode-shell.css not found')
const css = readFileSync(cssPath, 'utf8')

function cssBlock(selector: string): string {
  const start = css.indexOf(`${selector} {`)
  if (start === -1) throw new Error(`expected CSS rule ${selector}`)
  const end = css.indexOf('}', start)
  return css.slice(start, end)
}

describe('vscode-shell.css metrics', () => {
  it('keeps the menu bar and menu rows at 35px and 22px', () => {
    expect(cssBlock('.vscode-menu-bar')).toContain('height: var(--title-bar-h, 35px)')
    expect(cssBlock('.vscode-menu-bar__item')).toContain('padding: 0 8px')
    expect(cssBlock('.vscode-menu__item')).toContain('height: var(--menu-row-h, 24px)')
  })

  it('keeps a 48px activity bar with 48px items, 24px icons and a 2px active edge', () => {
    const bar = cssBlock('.vscode-activity-bar')
    const item = cssBlock('.vscode-activity-bar__item')
    expect(bar).toContain('width: var(--activity-bar-w, 48px)')
    expect(item).toContain('width: var(--activity-bar-w, 48px)')
    expect(item).toContain('height: var(--activity-bar-w, 48px)')
    expect(item).toContain('border-left: 2px')
    expect(cssBlock('.vscode-activity-bar__icon')).toContain('width: var(--activity-icon-size, 24px)')
    expect(cssBlock(".vscode-activity-bar__icon > .codicon[class*='codicon-']")).toContain('font-size: var(--activity-icon-size, 24px)')
    expect(cssBlock(".vscode-activity-bar__item[data-active='true']")).toContain('border-left-color')
  })

  it('keeps the editor tab strip at 35px with a 1px active top border and 16px close', () => {
    expect(cssBlock('.vscode-editor-tabs')).toContain('height: var(--editor-tabs-h, 35px)')
    expect(cssBlock('.vscode-editor-tab')).toContain('height: var(--editor-tabs-h, 35px)')
    expect(cssBlock(".vscode-editor-tab[data-active='true']")).toContain('border-top-color')
    expect(cssBlock('.vscode-editor-tab__close')).toContain('width: var(--ui-icon-size, 16px)')
    expect(cssBlock('.vscode-editor-tab__dirty')).toContain('width: 7px')
  })

  it('keeps the status bar 22px / 12px and items padded 0 5px', () => {
    const bar = cssBlock('.vscode-status-bar')
    expect(bar).toContain('height: var(--status-bar-h, 22px)')
    expect(bar).toContain('font-size: var(--status-font-size, 12px)')
    expect(cssBlock('.vscode-status-bar__item')).toContain('padding: 0 5px')
  })

  it('keeps breadcrumbs 22px / 12px and a 4px split sash', () => {
    const crumbs = cssBlock('.vscode-breadcrumbs')
    expect(crumbs).toContain('height: 22px')
    expect(crumbs).toContain('font-size: var(--ui-font-size-small, 12px)')
    expect(cssBlock(".vscode-split-view[data-orientation='horizontal']")).toContain('4px')
    expect(cssBlock('.vscode-split-view__sash')).toContain('width: 100%')
  })
})

describe('VscodeActivityBar', () => {
  const items = [
    { id: 'explorer', label: 'Explorer', icon: <span>E</span>, badge: 3 },
    { id: 'search', label: 'Search', icon: <span>S</span> },
  ]

  it('renders 48px entries, badges and the controlled active page', () => {
    render(<VscodeActivityBar items={items} activeId="explorer" onSelect={() => {}} />)

    expect(screen.getByRole('navigation', { name: 'Activity bar' })).toBeTruthy()
    const explorer = screen.getByRole('button', { name: 'Explorer, 3' })
    expect(explorer.getAttribute('aria-current')).toBe('page')
    expect(explorer.hasAttribute('title')).toBe(false)
    fireEvent.keyDown(document, { key: 'Tab' }) // keyboard navigation: focus alone does not open a tooltip
    fireEvent.focus(explorer)
    expect(screen.getByRole('tooltip').textContent).toBe('Explorer')
    fireEvent.blur(explorer)
    expect(explorer.querySelector('[data-slot="vscode-activity-bar-badge"]')?.textContent).toBe('3')
    expect(screen.getByRole('button', { name: 'Search' }).getAttribute('aria-current')).toBeNull()
  })

  it('reports clicks and moves focus with arrow keys', () => {
    const onSelect = vi.fn()
    render(<VscodeActivityBar items={items} activeId="explorer" onSelect={onSelect} />)

    const explorer = screen.getByRole('button', { name: 'Explorer, 3' })
    const search = screen.getByRole('button', { name: 'Search' })
    fireEvent.click(search)
    expect(onSelect).toHaveBeenCalledWith('search')

    explorer.focus()
    fireEvent.keyDown(explorer, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(search)
    fireEvent.keyDown(search, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(explorer)
  })
})

describe('VscodeStatusBar', () => {
  it('renders static and interactive items with tones and a polite live region', () => {
    const onZoom = vi.fn()
    render(
      <VscodeStatusBar
        left={[
          { id: 'workspace', label: 'webterm' },
          { id: 'agents', label: '3 working' },
        ]}
        right={[
          { id: 'remote', label: 'Remote', tone: 'remote' },
          { id: 'zoom', label: '100%', tooltip: 'Zoom level', onClick: onZoom },
        ]}
        liveText="3 agents working"
      />,
    )

    expect(screen.getByRole('contentinfo', { name: 'Status bar' })).toBeTruthy()
    expect(screen.getByText('webterm').closest('[data-slot]')?.getAttribute('data-tone')).toBe('default')
    expect(screen.getByText('Remote').closest('[data-slot]')?.getAttribute('data-tone')).toBe('remote')
    expect(screen.getByRole('status').textContent).toBe('3 agents working')

    fireEvent.click(screen.getByRole('button', { name: 'Zoom level' }))
    expect(onZoom).toHaveBeenCalledTimes(1)
  })
})

const menus = [
  {
    id: 'file',
    label: 'File',
    items: [
      { id: 'new', label: 'New File', keybinding: '⌘N', onSelect: () => {} },
      { type: 'separator' as const },
      { id: 'exit', label: 'Exit', disabled: true, onSelect: () => {} },
    ],
  },
  {
    id: 'view',
    label: 'View',
    items: [{ id: 'zoom', label: 'Zoom In', checked: true, onSelect: () => {} }],
  },
]

function MenuHarness({ onNew }: { onNew?: () => void }) {
  const [openId, setOpenId] = useState<string | null>(null)
  const data = menus.map((menu) =>
    menu.id === 'file'
      ? { ...menu, items: menu.items.map((item) => ('id' in item && item.id === 'new' ? { ...item, onSelect: onNew } : item)) }
      : menu,
  )
  return <VscodeMenuBar menus={data} openId={openId} onOpenChange={setOpenId} />
}

describe('VscodeMenuBar', () => {
  it('opens a menu, supports arrows and Escape, and selects items', () => {
    const onNew = vi.fn()
    render(<MenuHarness onNew={onNew} />)

    const file = screen.getByRole('menuitem', { name: 'File' })
    fireEvent.click(file)
    expect(file.getAttribute('aria-expanded')).toBe('true')
    const menu = screen.getByRole('menu', { name: 'File' })
    expect(menu).toBeTruthy()
    expect(document.activeElement?.textContent).toContain('New File')

    fireEvent.keyDown(menu, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(file.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(file)
    fireEvent.click(screen.getByRole('menuitem', { name: /^New File/ }))
    expect(onNew).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('does not activate disabled rows and exposes checked rows', () => {
    render(<MenuHarness />)
    fireEvent.click(screen.getByRole('menuitem', { name: 'File' }))

    const exit = screen.getByRole('menuitem', { name: 'Exit' })
    expect(exit.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(exit)
    expect(screen.getByRole('menu', { name: 'File' })).toBeTruthy()

    const view = screen.getByRole('menuitem', { name: 'View' })
    fireEvent.mouseEnter(view)
    expect(view.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('menuitemcheckbox', { name: 'Zoom In' }).getAttribute('aria-checked')).toBe('true')
  })

  it('moves between top-level menus with ArrowRight while open', () => {
    render(<MenuHarness />)
    const file = screen.getByRole('menuitem', { name: 'File' })
    fireEvent.keyDown(file, { key: 'ArrowDown' })
    expect(screen.getByRole('menu', { name: 'File' })).toBeTruthy()

    const menu = screen.getByRole('menu', { name: 'File' })
    fireEvent.keyDown(menu, { key: 'ArrowRight' })
    expect(screen.getByRole('menu', { name: 'View' })).toBeTruthy()
  })
})

function TabHarness({ onActivate, onClose }: { onActivate: (id: string) => void; onClose: (id: string) => void }) {
  const [activeId, setActiveId] = useState('one')
  return (
    <VscodeEditorTabBar
      activeId={activeId}
      onActivate={(id) => {
        setActiveId(id)
        onActivate(id)
      }}
      onClose={onClose}
      tabs={[
        { id: 'one', label: 'one.ts', dirty: true },
        { id: 'two', label: 'two.ts' },
        { id: 'pinned', label: 'pinned.ts', closable: false },
      ]}
    />
  )
}

describe('VscodeEditorTabBar', () => {
  it('renders tabs with selection, dirty state and close affordances', () => {
    render(<TabHarness onActivate={() => {}} onClose={() => {}} />)

    expect(screen.getByRole('tablist', { name: 'Editor tabs' })).toBeTruthy()
    const one = screen.getByRole('tab', { name: 'one.ts' })
    expect(one.getAttribute('aria-selected')).toBe('true')
    // Titik dirty menempati slot close (seperti VS Code), bukan tombol tab.
    const close = screen.getByRole('button', { name: 'Close one.ts' })
    expect(one.querySelector('[data-slot="vscode-editor-tab-dirty"]')).toBeNull()
    expect(close.querySelector('[data-slot="vscode-editor-tab-dirty"]')).not.toBeNull()
    expect(close.querySelector('.codicon-close')).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Close pinned.ts' })).toBeNull()
  })

  it('activates on click and closes without activating', () => {
    const onActivate = vi.fn()
    const onClose = vi.fn()
    render(<TabHarness onActivate={onActivate} onClose={onClose} />)

    fireEvent.click(screen.getByRole('tab', { name: 'two.ts' }))
    expect(onActivate).toHaveBeenCalledWith('two')

    fireEvent.click(screen.getByRole('button', { name: 'Close one.ts' }))
    expect(onClose).toHaveBeenCalledWith('one')
    expect(onActivate).toHaveBeenCalledTimes(1)
  })

  it('moves focus with arrows and activates or closes the focused tab', () => {
    const onActivate = vi.fn()
    const onClose = vi.fn()
    render(<TabHarness onActivate={onActivate} onClose={onClose} />)

    const one = screen.getByRole('tab', { name: 'one.ts' })
    const two = screen.getByRole('tab', { name: 'two.ts' })
    one.focus()
    fireEvent.keyDown(one, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(two)
    expect(onActivate).not.toHaveBeenCalled()

    fireEvent.keyDown(two, { key: 'Enter' })
    expect(onActivate).toHaveBeenCalledWith('two')

    fireEvent.keyDown(two, { key: 'Delete' })
    expect(onClose).toHaveBeenCalledWith('two')
  })
})

describe('VscodeEditorTabBar — VS Code tab gestures', () => {
  it('closes on middle click and reports double click', () => {
    const onClose = vi.fn()
    const onDoubleClick = vi.fn()
    render(
      <VscodeEditorTabBar
        activeId="a"
        onActivate={() => {}}
        onClose={onClose}
        onDoubleClick={onDoubleClick}
        tabs={[{ id: 'a', label: 'a.ts' }, { id: 'b', label: 'b.ts', closable: false }]}
      />,
    )
    fireEvent(screen.getByRole('tab', { name: 'a.ts' }), new MouseEvent('auxclick', { bubbles: true, button: 1 }))
    expect(onClose).toHaveBeenCalledWith('a')
    fireEvent(screen.getByRole('tab', { name: 'b.ts' }), new MouseEvent('auxclick', { bubbles: true, button: 1 }))
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.doubleClick(screen.getByRole('tab', { name: 'b.ts' }))
    expect(onDoubleClick).toHaveBeenCalledWith('b')
  })

  it('draws the dirty dot in the close slot of a non-closable tab too', () => {
    render(<VscodeEditorTabBar activeId="p" onActivate={() => {}} tabs={[{ id: 'p', label: 'p.ts', dirty: true, closable: false }]} />)
    expect(document.querySelector('.vscode-editor-tab__close [data-slot="vscode-editor-tab-dirty"]')).not.toBeNull()
  })
})

describe('codicon glyphs and chrome css', () => {
  it('uses codicons for menu check/caret and breadcrumb separators, not text or inline svg', () => {
    render(<MenuHarness />)
    fireEvent.click(screen.getByRole('menuitem', { name: 'File' }))
    fireEvent.mouseEnter(screen.getByRole('menuitem', { name: 'View' }))
    expect(document.querySelector('.codicon-check')).not.toBeNull()
    cleanup()
    render(<VscodeBreadcrumbs segments={[{ id: 'a', label: 'a' }, { id: 'b', label: 'b' }]} />)
    expect(document.querySelector('.vscode-breadcrumbs__separator .codicon-chevron-right')).not.toBeNull()
    expect(document.querySelector('.vscode-breadcrumbs svg')).toBeNull()
  })

  it('keeps chrome cursors default and tabs separated by tab.border', () => {
    expect(css).not.toMatch(/cursor:\s*(pointer|not-allowed)/)
    expect(css).toContain('border-right: 1px solid var(--vscode-tab-border)')
    for (const tone of ['remote', 'prominent', 'debugging', 'warning', 'error']) {
      expect(css).toContain(`[data-tone='${tone}']`)
    }
  })

  it('renders every status tone through data-tone', () => {
    render(<VscodeStatusBar left={[]} right={(['prominent', 'debugging'] as const).map((tone) => ({ id: tone, label: tone, tone }))} />)
    expect(screen.getByText('debugging').closest('[data-slot]')?.getAttribute('data-tone')).toBe('debugging')
    expect(screen.getByText('prominent').closest('[data-slot]')?.getAttribute('data-tone')).toBe('prominent')
  })
})

describe('VscodeMenuBar — Alt focuses the menu bar', () => {
  it('focuses the first menu on a lone Alt tap but not when another key was pressed or typing', () => {
    render(<><input aria-label="field" /><MenuHarness /></>)
    const file = screen.getByRole('menuitem', { name: 'File' })

    fireEvent.keyDown(document.body, { key: 'Alt' })
    fireEvent.keyUp(document.body, { key: 'Alt' })
    expect(document.activeElement).toBe(file)

    file.blur()
    fireEvent.keyDown(document.body, { key: 'Alt' })
    fireEvent.keyDown(document.body, { key: 'k' })
    fireEvent.keyUp(document.body, { key: 'Alt' })
    expect(document.activeElement).not.toBe(file)

    const field = screen.getByLabelText('field')
    field.focus()
    fireEvent.keyDown(field, { key: 'Alt' })
    fireEvent.keyUp(field, { key: 'Alt' })
    expect(document.activeElement).toBe(field)
  })
})

describe('VscodeBreadcrumbs', () => {
  const segments = [
    { id: 'src', label: 'src', onClick: vi.fn() },
    { id: 'client', label: 'client', onClick: vi.fn() },
    { id: 'app', label: 'app.tsx' },
  ]

  it('renders chevrons and marks only the last segment as current', () => {
    render(<VscodeBreadcrumbs segments={segments} />)

    const current = screen.getByText('app.tsx')
    expect(current.getAttribute('aria-current')).toBe('page')
    expect(screen.getByText('src').getAttribute('aria-current')).toBeNull()
    expect(document.querySelectorAll('.vscode-breadcrumbs__separator')).toHaveLength(2)
  })

  it('selects an interactive segment', () => {
    render(<VscodeBreadcrumbs segments={segments} />)
    fireEvent.click(screen.getByText('src'))
    expect(segments[0].onClick).toHaveBeenCalled()
  })

  it('collapses overflow into a leading ellipsis menu', () => {
    const onSelect = vi.fn()
    render(
      <VscodeBreadcrumbs
        segments={[
          { id: 'a', label: 'a' },
          { id: 'b', label: 'b' },
          { id: 'c', label: 'c' },
        ]}
        maxVisible={2}
        onSelect={onSelect}
      />,
    )

    const trigger = screen.getByRole('button', { name: 'Show hidden path segments' })
    expect(screen.queryByText('a')).toBeNull()
    fireEvent.click(trigger)
    expect(screen.getByRole('menu')).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitem', { name: 'a' }))
    expect(onSelect).toHaveBeenCalledWith('a')
    expect(screen.queryByRole('menu')).toBeNull()
  })
})

function SplitHarness({ start = 200 }: { start?: number }) {
  const [size, setSize] = useState(start)
  return (
    <div>
      <span data-testid="size">{size}</span>
      <VscodeSplitView
        size={size}
        onSizeChange={setSize}
        minSize={77}
        maxSize={500}
        defaultSize={240}
        start={<div>start pane</div>}
        end={<div>end pane</div>}
      />
    </div>
  )
}

function splitSash() {
  return screen.getByRole('separator', { name: 'Resize panes' })
}

describe('VscodeSplitView', () => {
  it('exposes separator semantics and the controlled size', () => {
    render(<SplitHarness />)
    const sash = splitSash()
    expect(sash.getAttribute('aria-orientation')).toBe('horizontal')
    expect(sash.getAttribute('aria-valuenow')).toBe('200')
    expect(sash.getAttribute('aria-valuemin')).toBe('77')
    expect(sash.getAttribute('aria-valuemax')).toBe('500')
    expect(sash.tabIndex).toBe(0)
    expect(screen.getByText('start pane')).toBeTruthy()
    expect(screen.getByText('end pane')).toBeTruthy()
  })

  it('resizes with arrows, Shift, Home and End', () => {
    render(<SplitHarness />)
    const size = () => screen.getByTestId('size').textContent

    // ArrowUp moves the sash up, shrinking the top/start pane.
    fireEvent.keyDown(splitSash(), { key: 'ArrowUp' })
    expect(size()).toBe('190')
    fireEvent.keyDown(splitSash(), { key: 'ArrowDown', shiftKey: true })
    expect(size()).toBe('240')
    fireEvent.keyDown(splitSash(), { key: 'Home' })
    expect(size()).toBe('77')
    fireEvent.keyDown(splitSash(), { key: 'End' })
    expect(size()).toBe('500')
  })

  it('restores the default size on double-click', () => {
    render(<SplitHarness start={120} />)
    fireEvent.doubleClick(splitSash())
    expect(screen.getByTestId('size').textContent).toBe('240')
  })

  it('drags the sash and stops tracking on pointer up', () => {
    render(<SplitHarness />)
    const sash = splitSash()
    fireEvent.pointerDown(sash, { button: 0, pointerId: 1, clientY: 100 })
    fireEvent.pointerMove(sash, { pointerId: 1, clientY: 150 })
    expect(screen.getByTestId('size').textContent).toBe('250')
    fireEvent.pointerUp(sash, { pointerId: 1 })
    fireEvent.pointerMove(sash, { pointerId: 1, clientY: 400 })
    expect(screen.getByTestId('size').textContent).toBe('250')
  })
})
