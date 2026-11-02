/**
 * @vitest-environment jsdom
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  VscodeCard,
  VscodeCardBody,
  VscodeCardFooter,
  VscodeCardHeader,
  VscodeCardTitle,
} from './vscodeCard'
import { VscodeQuickPick } from './vscodeQuickPick'
import type { VscodeQuickPickItem } from './vscodeQuickPick'

afterEach(cleanup)

// jsdom rewrites `import.meta.url` to an http URL, so resolve from cwd. Vitest's
// root is `src/client`, while npm scripts run from the repo root; accept both.
const cssPath = [
  path.resolve(process.cwd(), 'src/client/components/vscode/vscode-controls.css'),
  path.resolve(process.cwd(), 'components/vscode/vscode-controls.css'),
].find(existsSync)
if (!cssPath) throw new Error('vscode-controls.css not found')
const css = readFileSync(cssPath, 'utf8')

function cssBlock(selector: string): string {
  const start = css.indexOf(`${selector} {`)
  if (start === -1) throw new Error(`expected CSS rule ${selector}`)
  const end = css.indexOf('}', start)
  return css.slice(start, end)
}

describe('vscode-controls.css metrics', () => {
  it('keeps the card on the 3px VS Code radius', () => {
    expect(cssBlock('.vscode-card')).toContain('border-radius: 3px')
  })
})

describe('VscodeCard', () => {
  it('renders header, title, body and footer slots', () => {
    render(
      <VscodeCard>
        <VscodeCardHeader>
          <VscodeCardTitle>Terminal</VscodeCardTitle>
        </VscodeCardHeader>
        <VscodeCardBody>Body</VscodeCardBody>
        <VscodeCardFooter>Footer</VscodeCardFooter>
      </VscodeCard>,
    )

    expect(document.querySelector('[data-slot="vscode-card"]')).not.toBeNull()
    expect(document.querySelector('[data-slot="vscode-card-header"]')).not.toBeNull()
    expect(document.querySelector('[data-slot="vscode-card-title"]')?.textContent).toBe('Terminal')
    expect(document.querySelector('[data-slot="vscode-card-body"]')?.textContent).toBe('Body')
    expect(document.querySelector('[data-slot="vscode-card-footer"]')?.textContent).toBe('Footer')
  })

  it('marks the tile variant and forwards div attributes', () => {
    render(
      <VscodeCard variant="tile" id="welcome" aria-label="Welcome">
        hi
      </VscodeCard>,
    )

    const card = document.getElementById('welcome')
    expect(card?.getAttribute('data-variant')).toBe('tile')
    expect(card?.getAttribute('aria-label')).toBe('Welcome')
  })
})

const items: VscodeQuickPickItem[] = [
  { id: 'new-terminal', label: 'New Terminal', description: 'Terminal', keybinding: 'Ctrl+`', group: 'Terminal' },
  { id: 'close-terminal', label: 'Close Terminal', description: 'Terminal', group: 'Terminal' },
  { id: 'open-settings', label: 'Open Settings', description: 'Preferences', group: 'Preferences' },
  { id: 'locked', label: 'Locked Command', description: 'Disabled', disabled: true },
]

describe('VscodeQuickPick', () => {
  it('renders nothing while closed', () => {
    render(
      <VscodeQuickPick
        open={false}
        onClose={() => {}}
        placeholder="Type a command"
        items={items}
        onSelect={() => {}}
      />,
    )

    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('focuses the input, renders a listbox of options and group headings', () => {
    render(
      <VscodeQuickPick
        open
        onClose={() => {}}
        placeholder="Type a command"
        items={items}
        onSelect={() => {}}
      />,
    )

    const input = screen.getByRole('combobox', { name: 'Type a command' })
    expect(document.activeElement).toBe(input)
    expect(input.getAttribute('data-slot')).toBe('vscode-quick-pick-input')
    expect(input.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('listbox').getAttribute('data-slot')).toBe('vscode-quick-pick-list')
    expect(screen.getAllByRole('option')).toHaveLength(4)
    expect(document.querySelectorAll('[data-slot="vscode-quick-pick-group"]')).toHaveLength(2)
    expect(
      document.querySelector('[data-slot="vscode-quick-pick-item"]')?.getAttribute('data-active'),
    ).toBe('true')
  })

  it('filters by label and description, then selects with Enter', () => {
    const onSelect = vi.fn()
    render(
      <VscodeQuickPick
        open
        onClose={() => {}}
        placeholder="Type a command"
        items={items}
        onSelect={onSelect}
      />,
    )

    const input = screen.getByRole('combobox')
    fireEvent.change(input, { target: { value: 'settings' } })
    expect(screen.getAllByRole('option')).toHaveLength(1)
    expect(screen.getByRole('option').textContent).toContain('Open Settings')

    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSelect).toHaveBeenCalledWith('open-settings')

    fireEvent.change(input, { target: { value: 'Preferences' } })
    expect(screen.getAllByRole('option')).toHaveLength(1)
  })

  it('moves the active row with arrows, skips disabled rows and does not wrap', () => {
    render(
      <VscodeQuickPick
        open
        onClose={() => {}}
        placeholder="Type a command"
        items={items}
        onSelect={() => {}}
      />,
    )

    const input = screen.getByRole('combobox')
    const options = screen.getAllByRole('option')
    expect(options[0].getAttribute('aria-selected')).toBe('true')

    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(options[0].getAttribute('aria-selected')).toBe('true')

    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(screen.getAllByRole('option')[1].getAttribute('aria-selected')).toBe('true')

    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(screen.getAllByRole('option')[2].getAttribute('aria-selected')).toBe('true')

    // Last row is disabled: arrow down must not activate it.
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(screen.getAllByRole('option')[2].getAttribute('aria-selected')).toBe('true')
    expect(input.getAttribute('aria-activedescendant')).toBe(
      screen.getAllByRole('option')[2].id,
    )
  })

  it('selects the active row by click and ignores disabled rows', () => {
    const onSelect = vi.fn()
    render(
      <VscodeQuickPick
        open
        onClose={() => {}}
        placeholder="Type a command"
        items={items}
        onSelect={onSelect}
      />,
    )

    const options = screen.getAllByRole('option')
    fireEvent.click(options[1])
    expect(onSelect).toHaveBeenCalledWith('close-terminal')

    fireEvent.click(options[3])
    expect(onSelect).toHaveBeenCalledTimes(1)
  })

  it('closes on Escape and on outside mousedown', () => {
    const onClose = vi.fn()
    render(
      <VscodeQuickPick
        open
        onClose={onClose}
        placeholder="Type a command"
        items={items}
        onSelect={() => {}}
      />,
    )

    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)

    fireEvent.mouseDown(document.body)
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('shows the empty text and supports a caller-provided rank', () => {
    const rank = (item: VscodeQuickPickItem, query: string) =>
      item.id === 'open-settings' && query === 'zzz' ? 0 : null

    const { rerender } = render(
      <VscodeQuickPick
        open
        onClose={() => {}}
        placeholder="Type a command"
        items={items}
        onSelect={() => {}}
        emptyText="Nothing here"
        rank={rank}
      />,
    )

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'zzz' } })
    expect(screen.getAllByRole('option')).toHaveLength(1)
    expect(document.querySelector('[data-slot="vscode-quick-pick-empty"]')).toBeNull()

    rerender(
      <VscodeQuickPick
        open
        onClose={() => {}}
        placeholder="Type a command"
        items={items}
        onSelect={() => {}}
        emptyText="Nothing here"
        rank={() => null}
      />,
    )
    expect(document.querySelector('[data-slot="vscode-quick-pick-empty"]')?.textContent).toBe(
      'Nothing here',
    )
  })
})
