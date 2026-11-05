/**
 * @vitest-environment jsdom
 */
// Palette ⌘K di canvas: yang diuji di sini adalah SAMBUNGANNYA ke quick pick VS Code, bukan
// perilaku internal quick pick (sudah dicakup `components/vscode/vscode-controls.test.tsx`).
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import CanvasToolbar, { kindIcon } from './CanvasToolbar'
import type { CanvasNodeLike } from './CanvasToolbar'

afterEach(cleanup)

const nodes: CanvasNodeLike[] = [
  { id: 'n-agent', type: 'agent', data: { kind: 'agent', title: 'Orchestrate SEO' } },
  { id: 'n-term', type: 'terminal', data: { kind: 'terminal', title: 'Build worker' } },
  { id: 'n-settings', type: 'terminal', data: { kind: 'terminal', title: 'Settings drone' } },
]

function renderToolbar(overrides: Partial<Parameters<typeof CanvasToolbar>[0]> = {}) {
  const props = {
    nodes,
    platform: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
    onFocusNode: vi.fn(),
    onOpenExplorer: vi.fn(),
    onOpenSettings: vi.fn(),
    onOpenHelp: vi.fn(),
    ...overrides,
  }
  render(<CanvasToolbar {...props} />)
  return props
}

const openWithShortcut = () => fireEvent.keyDown(window, { key: 'k', metaKey: true })

describe('CanvasToolbar chrome', () => {
  it('uses codicons (no svg) and shows the shortcut in the palette tooltip', () => {
    renderToolbar()
    const cluster = document.querySelector('.controls-cluster')!
    expect(cluster.querySelector('svg')).toBeNull()
    expect([...cluster.querySelectorAll('.codicon')].map((e) => e.className)).toEqual([
      'codicon codicon-search',
      'codicon codicon-files',
      'codicon codicon-settings-gear',
      'codicon codicon-question',
    ])
    const palette = screen.getByRole('button', { name: 'Command palette' })
    expect(palette.hasAttribute('title')).toBe(false)
    fireEvent.focus(palette)
    expect(screen.getByRole('tooltip').textContent).toBe('Command palette ⌘K')
  })
})

describe('CanvasToolbar palette icons (G-10)', () => {
  it('kindIcon: agent=hubot, files=folder, editor=edit, lainnya=terminal', () => {
    expect([kindIcon('agent'), kindIcon('files'), kindIcon('editor'), kindIcon('terminal'), kindIcon('x'), kindIcon()]).toEqual([
      'hubot', 'folder', 'edit', 'terminal', 'terminal', 'terminal',
    ])
  })

  it('tiap baris palette memakai ikon sesuai tipe node', () => {
    renderToolbar({
      nodes: [
        { id: 'a', type: 'agent', data: { kind: 'agent', title: 'Agent one' } },
        { id: 'f', type: 'files', data: { kind: 'files', title: 'Files one' } },
        { id: 'e', type: 'editor', data: { kind: 'editor', title: 'Editor one' } },
        { id: 't', type: 'terminal', data: { kind: 'terminal', title: 'Term one' } },
      ],
    })
    openWithShortcut()
    const iconOf = (name: string) =>
      screen.getByRole('option', { name: new RegExp(name) }).querySelector('.codicon')?.className
    expect(iconOf('Agent one')).toBe('codicon codicon-hubot')
    expect(iconOf('Files one')).toBe('codicon codicon-folder')
    expect(iconOf('Editor one')).toBe('codicon codicon-edit')
    expect(iconOf('Term one')).toBe('codicon codicon-terminal')
  })
})

describe('CanvasToolbar palette', () => {
  it('keeps the canvas controls and opens the quick pick from the search button', () => {
    const props = renderToolbar()

    expect(screen.getByRole('button', { name: 'Command palette' }).textContent).toContain('⌘K')

    fireEvent.click(screen.getByRole('button', { name: 'New Files node' }))
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    fireEvent.click(screen.getByRole('button', { name: 'Keyboard shortcuts' }))
    expect(props.onOpenExplorer).toHaveBeenCalledTimes(1)
    expect(props.onOpenSettings).toHaveBeenCalledTimes(1)
    expect(props.onOpenHelp).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Command palette' }))
    const input = screen.getByRole('combobox', { name: 'Find a node by name or type…' })
    expect(document.activeElement).toBe(input)
    expect(screen.getAllByRole('option')).toHaveLength(3)
  })

  it('opens on Cmd+K and Ctrl+K but not on a bare k', () => {
    renderToolbar()

    fireEvent.keyDown(window, { key: 'k' })
    expect(screen.queryByRole('dialog')).toBeNull()

    openWithShortcut()
    expect(screen.getByRole('dialog', { name: 'Find node' })).not.toBeNull()
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.keyDown(window, { key: 'K', ctrlKey: true })
    expect(screen.getByRole('dialog', { name: 'Find node' })).not.toBeNull()
  })

  it('ranks node labels and node types, then focuses the active node with Enter', () => {
    const props = renderToolbar()
    openWithShortcut()

    const input = screen.getByRole('combobox')
    fireEvent.change(input, { target: { value: 'worker' } })
    expect(screen.getAllByRole('option')).toHaveLength(1)
    expect(screen.getByRole('option').textContent).toContain('Build worker')

    fireEvent.change(input, { target: { value: 'agent' } })
    expect(screen.getAllByRole('option')).toHaveLength(1)
    expect(screen.getByRole('option').textContent).toContain('Orchestrate SEO')

    fireEvent.change(input, { target: { value: '' } })
    const options = screen.getAllByRole('option')
    expect(options[0].getAttribute('aria-selected')).toBe('true')

    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(screen.getAllByRole('option')[1].getAttribute('aria-selected')).toBe('true')

    fireEvent.keyDown(input, { key: 'Enter' })
    expect(props.onFocusNode).toHaveBeenCalledWith('n-term')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('closes on Escape and reports an empty result set', () => {
    const props = renderToolbar()
    openWithShortcut()

    const input = screen.getByRole('combobox')
    fireEvent.change(input, { target: { value: 'zzzz' } })
    expect(screen.queryAllByRole('option')).toHaveLength(0)
    expect(document.querySelector('[data-slot="vscode-quick-pick-empty"]')?.textContent).toBe(
      'No matches',
    )

    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(props.onFocusNode).not.toHaveBeenCalled()
  })

  it('selects a row on click', () => {
    const props = renderToolbar()
    openWithShortcut()

    fireEvent.click(screen.getAllByRole('option')[2])
    expect(props.onFocusNode).toHaveBeenCalledWith('n-settings')
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('canvas-ui.css', () => {
  const cssPath = [
    path.resolve(process.cwd(), 'src/client/canvas-ui.css'),
    path.resolve(process.cwd(), 'canvas-ui.css'),
  ].find((candidate) => {
    try {
      readFileSync(candidate)
      return true
    } catch {
      return false
    }
  })
  if (!cssPath) throw new Error('canvas-ui.css not found')
  const css = readFileSync(cssPath, 'utf8')

  it('no longer carries the retired cmdk palette rules', () => {
    expect(css).not.toContain('.canvas-command-')
    expect(css).not.toContain('.palette__')
  })

  it('tidak memuat sisa menu lama (.node-menu*): menu canvas = VscodeMenu', () => {
    expect(css).not.toContain('.node-menu')
  })

  it('G-1: tombol search lebih spesifik dari `.controls-cluster > button`, jadi chip tak menimpa Explorer', () => {
    const rule = (sel: string) => new RegExp(`(?:^|\\n)${sel.replace(/[.>*]/g, '\\$&')} \\{([^}]*)\\}`).exec(css)?.[1] ?? ''
    const generic = rule('.controls-cluster > button')
    expect(generic).toContain('width: 22px')
    // `.x > .y` = 2 kelas (0,2,0) > `.x > button` = 1 kelas + 1 tag (0,1,1).
    const search = rule('.controls-cluster > .cluster-search')
    expect(search).toContain('width: auto')
    expect(search).toContain('padding: 0 6px')
    expect(css).not.toMatch(/\n\.cluster-search \{/)
  })

  it('G-2: cluster di kiri-bawah (tidak menutupi tombol header node), shadow widget', () => {
    const body = /(?:^|\n)\.controls-cluster \{([^}]*)\}/.exec(css)?.[1] ?? ''
    expect(body).toContain('bottom: var(--float-gap)')
    expect(body).toContain('left: var(--float-gap)')
    expect(body).not.toMatch(/\btop:/)
    expect(body).toContain('border-radius: 8px')
    expect(body).toContain('box-shadow: var(--wt-shadow-floating)')
  })
})

describe('CanvasToolbar with the app omnibox (onOpenPalette)', () => {
  it('the search button opens the omnibox, and ⌘K is left to the command registry', () => {
    const onOpenPalette = vi.fn()
    renderToolbar({ onOpenPalette })
    fireEvent.click(screen.getByRole('button', { name: 'Command palette' }))
    expect(onOpenPalette).toHaveBeenCalledTimes(1)
    openWithShortcut()
    expect(onOpenPalette).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog', { name: 'Find node' })).toBeNull()
  })
})
