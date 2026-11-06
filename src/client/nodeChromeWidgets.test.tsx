/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import NodeColorSwatch, { NODE_COLORS } from './NodeColorSwatch'
import NodeComments from './NodeComments'
import NodeToolbar from './NodeToolbar'
import NodeChrome from './NodeChrome'
import UsagePill from './UsagePill'

afterEach(cleanup)

describe('NodeColorSwatch', () => {
  // Popover diportal ke body (tidak ter-clip `.term-node`), jadi dicari lewat `document`.
  const pop = () => document.querySelector('.node-swatch-pop')

  it('opens a popover of swatches, marks the current one and closes on pick', () => {
    const onColor = vi.fn()
    const { container } = render(<NodeColorSwatch color={NODE_COLORS[1]} onColor={onColor} />)
    expect(pop()).toBeNull()
    fireEvent.click(container.querySelector('[data-title="Color"]') as Element)
    expect(pop()?.getAttribute('data-slot')).toBe('vscode-popover')
    expect(container.querySelector('.node-swatch-pop')).toBeNull()
    const swatches = document.querySelectorAll('button.node-swatch')
    expect(swatches).toHaveLength(NODE_COLORS.length)
    expect(document.querySelectorAll('button.node-swatch[aria-pressed="true"]')).toHaveLength(1)
    expect(swatches[1].getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(swatches[3])
    expect(onColor).toHaveBeenCalledWith(NODE_COLORS[3])
    expect(pop()).toBeNull()
  })

  it('closes on Escape and on a press outside', () => {
    const { container } = render(<NodeColorSwatch color={NODE_COLORS[0]} onColor={() => {}} />)
    const open = () => fireEvent.click(container.querySelector('[data-title="Color"]') as Element)
    open()
    expect(pop()).not.toBeNull()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(pop()).toBeNull()
    open()
    fireEvent.pointerDown(document.body)
    expect(pop()).toBeNull()
  })
})

describe('NodeComments', () => {
  const mk = (over: Partial<Parameters<typeof NodeComments>[0]> = {}) =>
    render(<NodeComments comments={[]} onAdd={() => {}} onClose={() => {}} {...over} />)

  it('is a labelled dialog that focuses the input and shows the empty state', () => {
    mk()
    expect(screen.getByRole('dialog', { name: 'Comments' })).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByLabelText('Add a comment'))
    expect(screen.getByText('No comments yet')).toBeTruthy()
  })

  it('adds a trimmed comment on Enter and on the Add Comment button, never an empty one', () => {
    const onAdd = vi.fn()
    mk({ onAdd })
    const input = screen.getByLabelText('Add a comment') as HTMLTextAreaElement
    fireEvent.click(screen.getByText('Add Comment'))
    expect(onAdd).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: '  hello  ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onAdd).toHaveBeenCalledWith('hello')
    expect(input.value).toBe('')
    fireEvent.change(input, { target: { value: 'x' } })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(onAdd).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByText('Add Comment'))
    expect(onAdd).toHaveBeenLastCalledWith('x')
  })

  it('closes on Escape', () => {
    const onClose = vi.fn()
    mk({ onClose })
    fireEvent.keyDown(screen.getByLabelText('Add a comment'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('NodeToolbar', () => {
  const base = {
    onRefresh: () => {}, searchOpen: false, onToggleSearch: () => {},
    commentsOpen: false, onToggleComments: () => {}, onToggleMaximize: () => {}, onClose: () => {},
  }
  const labels = (c: HTMLElement) =>
    [...c.querySelectorAll('vscode-toolbar-button')].map((b) => b.getAttribute('data-title'))
  const icons = (c: HTMLElement) =>
    [...c.querySelectorAll('vscode-toolbar-button .codicon')].map((i) => i.className.replace('codicon ', ''))
  const menu = () => document.querySelector('[role="menu"][data-slot="vscode-menu"]')
  const rows = () => [...(menu()?.querySelectorAll('[role^="menuitem"]') ?? [])].map((r) => r.textContent)

  it('uses codicons and swaps Maximize/Restore with the state', () => {
    const a = render(<NodeToolbar {...base} maximized={false} />)
    expect(labels(a.container)).toContain('Maximize')
    expect(icons(a.container)).toEqual(expect.arrayContaining(['codicon-search', 'codicon-screen-full', 'codicon-ellipsis', 'codicon-close']))
    a.unmount()
    const b = render(<NodeToolbar {...base} maximized />)
    expect(labels(b.container)).toContain('Restore')
    expect(icons(b.container)).toContain('codicon-screen-normal')
    expect(b.container.querySelector('svg')).toBeNull()
  })

  it('puts Stop after More Actions… and a separator, then Close, only when wired', () => {
    const onStop = vi.fn()
    const a = render(<NodeToolbar {...base} maximized={false} onStop={onStop} />)
    expect(labels(a.container)).toEqual(['Search', 'Maximize', 'More Actions…', 'Stop Agent (keeps the node)', 'Close (ends the session)'])
    const stop = a.container.querySelector('[data-title="Stop Agent (keeps the node)"]') as Element
    expect(stop.previousElementSibling?.getAttribute('role')).toBe('separator')
    expect(stop.classList.contains('node-toolbar__stop')).toBe(true)
    fireEvent.click(stop)
    expect(onStop).toHaveBeenCalledTimes(1)
    a.unmount()
    const b = render(<NodeToolbar {...base} maximized={false} />)
    expect(labels(b.container)).not.toContain('Stop Agent (keeps the node)')
  })

  it('shows only the primary actions in the header; the rest live behind More Actions…', () => {
    const { container } = render(
      <NodeToolbar {...base} maximized={false} onToggleMic={() => {}} onAiName={() => {}} onToggleHideLinks={() => {}} />,
    )
    expect(labels(container)).toEqual(['Search', 'Maximize', 'More Actions…', 'Close (ends the session)'])
    expect(menu()).toBeNull()
    fireEvent.click(container.querySelector('[data-title="More Actions…"]') as Element)
    expect(rows()).toEqual(['Refresh view', 'Dictate', 'Name with AI', 'Comments', 'Hide links'])
  })

  it('runs the chosen overflow action, reflects state as checked, and closes the menu', () => {
    const onRefresh = vi.fn()
    const onToggleComments = vi.fn()
    const { container } = render(
      <NodeToolbar {...base} onRefresh={onRefresh} onToggleComments={onToggleComments} commentsOpen commentCount={2} maximized={false} />,
    )
    const open = () => fireEvent.click(container.querySelector('[data-title="More Actions…"]') as Element)
    open()
    const comments = [...document.querySelectorAll('[role="menuitemcheckbox"]')].find((r) => r.textContent === 'Comments (2)')
    expect(comments?.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(comments as Element)
    expect(onToggleComments).toHaveBeenCalledTimes(1)
    expect(menu()).toBeNull()
    open()
    fireEvent.click([...document.querySelectorAll('[role^="menuitem"]')].find((r) => r.textContent === 'Refresh view') as Element)
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  it('does not offer Name with AI / Dictate / links when the node cannot do them', () => {
    const { container } = render(<NodeToolbar {...base} maximized={false} />)
    fireEvent.click(container.querySelector('[data-title="More Actions…"]') as Element)
    expect(rows()).toEqual(['Refresh view', 'Comments'])
  })
})

describe('NodeChrome tab anatomy', () => {
  const props = {
    title: 'api', onRename: () => {}, collapsed: false, onToggleCollapse: () => {},
    color: NODE_COLORS[0], onColor: () => {}, comments: [], onAddComment: () => {},
    onRefresh: () => {}, searchOpen: false, onToggleSearch: () => {},
    maximized: false, onToggleMaximize: () => {}, onClose: () => {},
  }

  it('renders type icon, title, dim description and a codicon chevron', () => {
    const { container, rerender } = render(<NodeChrome {...props} icon="terminal" description="/srv/api" />)
    expect(container.querySelector('.node-icon.codicon-terminal')).toBeTruthy()
    expect(container.querySelector('.node-title')?.textContent).toBe('api')
    expect(container.querySelector('.node-description')?.textContent).toBe('/srv/api')
    expect(container.querySelector('.codicon-chevron-down')).toBeTruthy()
    rerender(<NodeChrome {...props} collapsed />)
    expect(container.querySelector('.codicon-chevron-right')).toBeTruthy()
    expect(container.querySelector('.node-icon')).toBeNull()
    expect(container.querySelector('.node-description')).toBeNull()
  })

  it('renders the status chip as a plain span with the literal label', () => {
    const { container } = render(<NodeChrome {...props} status="blocked" />)
    const chip = container.querySelector('.node-status--attention') as HTMLElement
    expect(chip.tagName).toBe('SPAN')
    expect(chip.textContent).toBe('NEEDS YOU')
  })
})

describe('UsagePill', () => {
  it('is a flat span with model label and percent', () => {
    const { container } = render(<UsagePill modelLabel="sonnet" usedPercent={42} />)
    const pill = container.querySelector('.usage-pill') as HTMLElement
    expect(pill.tagName).toBe('SPAN')
    expect(pill.textContent).toContain('sonnet')
    expect(pill.textContent).toContain('42%')
  })
})
