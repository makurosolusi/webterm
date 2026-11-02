/**
 * @vitest-environment jsdom
 */
// Palette ⌘K di canvas: yang diuji di sini adalah SAMBUNGANNYA ke quick pick VS Code, bukan
// perilaku internal quick pick (sudah dicakup `components/vscode/vscode-controls.test.tsx`).
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import CanvasToolbar from './CanvasToolbar'
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
    expect(screen.getByRole('button', { name: 'Command palette' }).getAttribute('title')).toBe('Command palette (⌘K)')
  })
})

describe('CanvasToolbar palette', () => {
  it('keeps the canvas controls and opens the quick pick from the search button', () => {
    const props = renderToolbar()

    expect(screen.getByRole('button', { name: 'Command palette' }).textContent).toContain('⌘K')

    fireEvent.click(screen.getByRole('button', { name: 'Explorer' }))
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    fireEvent.click(screen.getByRole('button', { name: 'Help' }))
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
})
