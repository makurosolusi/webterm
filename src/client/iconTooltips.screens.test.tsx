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

  it('site-info icon, zoom pill and ⋯ have visible tooltips', () => {
    render(<BrowserToolbar
      state={{ id: 'n1', url: 'http://a.com/', title: '', loading: false, canBack: false, canForward: false, lease: 'human', live: 'live' }}
      nav={() => {}} agentControl={false} agentEnabled onAgentControl={() => {}} zoom={1.3} onZoom={() => {}}
    />)
    expect(tipOf(screen.getByRole('img', { name: 'Not secure' }))).toBe('Connection is not secure (http): do not enter passwords or card numbers here')
    expect(tipOf(screen.getByRole('button', { name: 'Zoom 130%, reset to 100%' }))).toBe('Page zoom is 130%: click to reset to 100%')
    const more = screen.getByRole('button', { name: 'More actions' })
    expect(more.hasAttribute('title')).toBe(false)
    expect(tipOf(more)).toBe('Zoom, device mode, Shields, Design Mode and more')
  })
})

describe('FilesToolbar tooltips', () => {
  const ctx = { cwd: '/p', dir: '/p', entries: [], selection: [], expanded: new Set(), toggle: () => {}, collapseAll: () => {}, startRenameAt: () => {}, refresh() {}, startInput() {}, open() {}, notify: () => '', dismiss() {}, nodeId: 'f1' } as FilesSlotCtx
  it('every title-bar action carries a tooltip equal to its label, never a native title', () => {
    const view = { hidden: true, sortKey: 'mtime', sortDir: 'desc' } as ViewOpts
    render(<FilesToolbar view={view} onChange={() => {}} ctx={ctx} onNew={() => {}} onRefresh={() => {}} />)
    for (const name of ['New File…', 'New Folder…', 'Refresh Explorer', 'Collapse All', 'More Actions…']) {
      const b = screen.getByRole('button', { name })
      expect(b.hasAttribute('title')).toBe(false)
      expect(tipOf(b)).toBe(name)
    }
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
