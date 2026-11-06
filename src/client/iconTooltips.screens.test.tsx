/**
 * @vitest-environment jsdom
 */
// Screen controls migrated to IconButton / IconTooltip: browser toolbar, files toolbar, node color
// swatch, folder picker, welcome. Each shows a visible tooltip naming the click (and why when
// disabled) instead of a native `title`.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import './vscode/test-setup'
import BrowserToolbar from './BrowserToolbar'
import FilesToolbar from './FilesToolbar'
import FolderPicker from './FolderPicker'
import NodeColorSwatch from './NodeColorSwatch'
import Welcome from './Welcome'
import * as api from './api'
import type { FilesSlotCtx } from './filesSlots'
import type { ViewOpts } from '../shared/workspace'

const tipOf = (el: Element): string | null | undefined => {
  fireEvent.keyDown(document, { key: 'Tab' }) // keyboard navigation: focus alone does not open a tooltip
  fireEvent.focus(el)
  const text = document.querySelector('[role="tooltip"]')?.textContent
  fireEvent.blur(el)
  return text
}

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('BrowserToolbar tooltips', () => {
  it('names each nav action and says why a disabled one is off', () => {
    render(<BrowserToolbar
      state={{ id: 'n1', url: 'https://a.com/', title: '', loading: false, canBack: true, canForward: false, lease: 'human', live: 'live' }}
      nav={() => {}} agentControl={false} agentEnabled onAgentControl={() => {}} onZoom={() => {}}
    />)
    const back = screen.getByRole('button', { name: 'Back' })
    expect(back.hasAttribute('title')).toBe(false)
    expect(tipOf(back)).toBe('Go back one page')
    expect(tipOf(screen.getByRole('button', { name: 'Reload' }))).toBe('Reload this page')
    // Disabled trigger is wrapped in a focusable span (disabled buttons get no events).
    const fwd = screen.getByRole('button', { name: 'Forward' }).closest('[data-slot="icon-tooltip-disabled"]')!
    expect(tipOf(fwd)).toBe('Go forward one page (no later page)')
  })
})

describe('FilesToolbar tooltips', () => {
  const ctx = { cwd: '/p', dir: '/p', entries: [], selection: [], refresh() {}, startInput() {}, open() {}, notify: () => '', dismiss() {}, nodeId: 'f1' } as FilesSlotCtx
  it('states the hidden-files state and the current sort', () => {
    const view = { hidden: true, sortKey: 'mtime', sortDir: 'desc' } as ViewOpts
    render(<FilesToolbar view={view} onChange={() => {}} ctx={ctx} />)
    const eye = screen.getByRole('button', { name: 'Hide hidden files' })
    expect(eye.hasAttribute('title')).toBe(false)
    expect(tipOf(eye)).toBe('Hidden files are hidden: click to show them')
    expect(tipOf(screen.getByRole('button', { name: 'Sort' }))).toBe('Sort files (now by modified, descending)')
  })
})

describe('NodeColorSwatch tooltips', () => {
  it('describes the toggle and marks the current color', () => {
    const { container } = render(<NodeColorSwatch color="#0a84ff" onColor={() => {}} />)
    const toggle = container.querySelector('[data-title="Color"]')!
    expect(toggle.hasAttribute('title')).toBe(false)
    expect(tipOf(toggle)).toBe('Node color: click to choose one')
    fireEvent.click(toggle)
    expect(tipOf(screen.getByRole('button', { name: '#0a84ff' }))).toBe('#0a84ff (current color)')
    expect(tipOf(screen.getByRole('button', { name: '#d97757' }))).toBe('Set node color to #d97757')
  })
})

describe('FolderPicker tooltips', () => {
  it('Go up names the parent, and explains itself at the top', async () => {
    vi.spyOn(api, 'listDir').mockResolvedValue({ path: '/home/u', parent: '/home', dirs: [] })
    render(<FolderPicker onPick={() => {}} onClose={() => {}} />)
    await screen.findByText('/home/u')
    const up = screen.getByRole('button', { name: 'Go up' })
    expect(up.hasAttribute('title')).toBe(false)
    expect(tipOf(up)).toBe('Go up to /home')
  })
})

describe('Welcome tooltips', () => {
  it('a recently closed entry shows where it reopens', () => {
    render(<Welcome onNewProject={() => {}} onCreateEmpty={() => {}} onReopen={() => {}}
      closedSessions={[{ node: { id: 's1', kind: 'terminal', x: 0, y: 0, title: 'shell', cwd: '/w/app' }, workspaceId: 'w1', workspaceName: 'App', closedAt: 1 }]} />)
    const link = screen.getByRole('button', { name: /App/ })
    expect(link.hasAttribute('title')).toBe(false)
    expect(tipOf(link)).toBe('Reopen this session in /w/app')
  })
})
