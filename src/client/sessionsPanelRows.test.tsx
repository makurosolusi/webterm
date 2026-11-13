/** @vitest-environment jsdom */
// Sessions side bar rows and headers (sessions audit gaps 5-12): kind icon per node kind, no folder
// repeated under its own group, the status icon once per Status bucket, labeled header badges,
// Recently closed (Project only, collapsed, Restore inline, filtered, closed time) and Rename.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SessionsPanel, { type SessionsPanelProps } from './SessionsPanel'
import { __resetNodeStatusForTests } from './nodeStatus.store'
import { rowAge, rowDescription, rowTooltip } from './sessionList.row'
import { buildSessionList } from './sessionList'
import type { ClosedEntry } from './closedHistory'
import { DEFAULT_VIEWPORT, type Workspace, type WsNode } from '../shared/workspace'

// test-only fixtures
const node = (id: string, extra: Partial<WsNode> = {}): WsNode => ({ id, kind: 'terminal', x: 0, y: 0, ...extra })
const ws = (id: string, name: string, nodes: WsNode[], cwd?: string): Workspace => ({
  id, name, cwd, viewport: DEFAULT_VIEWPORT, nodes, bridges: [], updatedAt: 0,
})
const API = ws('pa', 'laya-api', [
  node('cc', { kind: 'agent', agentId: 'claude', name: 'Parsnip' }),
  node('ch', { kind: 'agentChat', agentId: 'claude', name: 'Puffin' }),
  node('sh', { title: 'shell', cwd: '/dev/laya-api/web' }),
], '/dev/laya-api')
const NOC = ws('pn', 'noc', [node('n1', { title: 'tail' })], '/dev/noc')
const CLOSED: ClosedEntry = {
  node: { id: 'old1', kind: 'agentChat', agentId: 'claude', title: 'Old chat', x: 0, y: 0 },
  workspaceId: 'pn', workspaceName: 'noc', closedAt: Date.now() - 5 * 60_000,
}

const props = (over: Partial<SessionsPanelProps> = {}): SessionsPanelProps => ({
  active: true, workspaces: [API, NOC], activeId: 'pa', liveActiveNodes: null,
  statuses: { cc: 'blocked', ch: 'working', n1: 'waiting' },
  reasons: { cc: { reason: 'permission', detail: 'Bash' } },
  onFocusNode: vi.fn(), onCloseSession: vi.fn(), onSelectWorkspace: vi.fn(), ...over,
})

const row = (prefix: string): HTMLElement => {
  const el = document.querySelector<HTMLElement>(`vscode-tree-item[aria-label^="${prefix}"]`)
  if (!el) throw new Error(`row "${prefix}" not rendered`)
  return el
}
const kindIcon = (el: Element) => el.querySelector('[slot="icon-leaf"] .codicon')?.className
const groupKeys = () => [...document.querySelectorAll('vscode-tree-item[data-group]')].map((g) => g.getAttribute('data-group'))

beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ nodes: {}, results: [] }))))
})
afterEach(() => { cleanup(); __resetNodeStatusForTests(); vi.unstubAllGlobals() })

describe('session rows', () => {
  it('kind icon per kind: Claude Code, Agent Chat and Terminal differ', () => {
    render(<SessionsPanel {...props()} />)
    expect(kindIcon(row('Parsnip · Claude Code'))).toContain('codicon-hubot')
    expect(kindIcon(row('Puffin · Agent Chat'))).toContain('codicon-comment-discussion')
    expect(kindIcon(row('shell'))).toContain('codicon-terminal')
  })

  it('Project tab: no folder repeated under its own group, only a different one; the reason shows', () => {
    render(<SessionsPanel {...props()} />)
    expect(row('Puffin · Agent Chat').querySelector('.ss-meta')).toBeNull()
    expect(row('shell').querySelector('.ss-meta')?.textContent).toBe('web')
    expect(row('Parsnip · Claude Code').querySelector('.ss-meta')?.textContent).toBe('Waiting for approval: Bash')
  })

  it('row glyph comes from the model with its label; full name in the tooltip', () => {
    render(<SessionsPanel {...props()} />)
    const r = row('Parsnip · Claude Code')
    expect(r.getAttribute('aria-label')).toBe('Parsnip · Claude Code — Waiting for approval: Bash')
    expect(r.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('Waiting for approval: Bash')
    expect(r.querySelector('.ss-tree__label')?.getAttribute('title')).toContain('Parsnip · Claude Code — laya-api — Waiting for approval: Bash')
    // Calm idle ("Ready" shell) renders no glyph at all.
    expect(row('shell').querySelector('[role="img"]')).toBeNull()
  })

  it('Status tab: the status icon is on the bucket header only, rows show the detail and workspace', () => {
    render(<SessionsPanel {...props()} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Status' }))
    expect(groupKeys()).toEqual(['status:needs-input', 'status:working', 'status:idle'])
    const needs = document.querySelector('vscode-tree-item[data-group="status:needs-input"]')
    expect(needs?.querySelector('[slot="icon-branch"] .codicon-bell')).not.toBeNull()
    const r = row('Parsnip · Claude Code')
    expect(r.querySelector('[role="img"]')).toBeNull()
    expect(r.querySelector('.ss-meta')?.textContent).toBe('Waiting for approval: Bash · laya-api')
    expect(row('tail').querySelector('.ss-meta')?.textContent).toBe('Turn ended · noc')
  })

  it('hover actions: Rename (open board only), End session, and ⋯ opening the row menu', () => {
    const onRenameNode = vi.fn()
    render(<SessionsPanel {...props({ onRenameNode })} />)
    expect(screen.getByLabelText('Rename shell')).toBeTruthy()
    expect(screen.queryByLabelText('Rename tail')).toBeNull()

    fireEvent.click(screen.getByLabelText('Rename shell'))
    const input = screen.getByLabelText('Session name') as HTMLInputElement
    expect(input.value).toBe('shell')
    fireEvent.change(input, { target: { value: 'api shell' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onRenameNode).toHaveBeenCalledWith('sh', 'api shell')

    fireEvent.click(screen.getByLabelText('More actions for shell'))
    expect(screen.getByRole('menuitem', { name: 'Rename…' }).getAttribute('aria-disabled')).not.toBe('true')
    expect(screen.getByRole('menuitem', { name: 'End Session' })).toBeTruthy()
  })
})

describe('group header', () => {
  it('labeled badges and an accessible name; the current workspace has no selection background class', () => {
    render(<SessionsPanel {...props()} />)
    const g = document.querySelector('vscode-tree-item[data-group="project:pa"]')
    expect(g?.getAttribute('aria-label')).toBe('laya-api, current workspace, 3 sessions, 1 needs you')
    expect(g?.querySelector('.ss-signal--attention')?.getAttribute('title')).toBe('1 needs you')
    expect(g?.querySelector('.ss-tree__count')?.getAttribute('title')).toBe('3 sessions')
    expect(g?.querySelector('.ss-ws__dot')).toBeNull()
    expect(document.querySelector('vscode-tree-item[data-group="project:pn"] .ss-signal--attention')).toBeNull()
  })
})

describe('Recently closed', () => {
  it('Project tab only, collapsed by default, kind icon and closed time', () => {
    render(<SessionsPanel {...props({ closedSessions: [CLOSED], onReopenSession: vi.fn() })} />)
    const closed = document.querySelector<HTMLElement & { open?: boolean }>('vscode-tree-item[data-group="closed"]')
    expect(closed?.hasAttribute('open')).toBe(false)
    const r = row('Reopen Old chat')
    expect(kindIcon(r)).toContain('codicon-comment-discussion')
    expect(r.querySelector('.ss-meta')?.textContent).toBe('noc · 5m ago')

    fireEvent.click(screen.getByRole('tab', { name: 'Status' }))
    expect(groupKeys()).not.toContain('closed')
  })

  it('inline Restore reopens directly; the filter applies to closed rows too', () => {
    const onReopenSession = vi.fn()
    render(<SessionsPanel {...props({ closedSessions: [CLOSED], onReopenSession })} />)
    fireEvent.click(screen.getByLabelText('Restore Old chat'))
    expect(onReopenSession).toHaveBeenCalledWith('old1')

    fireEvent.change(screen.getByLabelText('Filter sessions'), { target: { value: 'parsnip' } })
    expect(document.querySelector('vscode-tree-item[aria-label="Reopen Old chat"]')).toBeNull()
    fireEvent.change(screen.getByLabelText('Filter sessions'), { target: { value: 'old' } })
    expect(document.querySelector('vscode-tree-item[aria-label="Reopen Old chat"]')).not.toBeNull()
  })
})

describe('row text (pure)', () => {
  const [g] = buildSessionList([API], null, 'pa', { cc: 'blocked' }, '', undefined, { facts: { cc: { live: true, statusSince: 1_000 } } })
  const cc = g.sessions[0]

  it('relative time: now / 5m / 2h / 3d, blank when unknown', () => {
    expect(rowAge(undefined, 0)).toBe('')
    expect(rowAge(0, 30_000)).toBe('now')
    expect(rowAge(0, 5 * 60_000)).toBe('5m')
    expect(rowAge(0, 2 * 3_600_000 + 60_000)).toBe('2h')
    expect(rowAge(0, 3 * 86_400_000)).toBe('3d')
  })

  it('description by mode, tooltip with name, folder, status and age', () => {
    expect(rowDescription(cc, 'project', API.cwd)).toBe('Waiting for your approval')
    expect(rowDescription(cc, 'status')).toBe('Waiting for your approval · laya-api')
    expect(rowTooltip(cc, 1_000 + 5 * 60_000)).toBe('Parsnip · Claude Code — laya-api — Waiting for your approval · 5m ago')
  })
})
