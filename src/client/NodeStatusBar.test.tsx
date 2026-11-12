/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../shared/settings'
import type { NodeStatusInfo } from '../shared/nodeStatusBar'
import { SettingsProvider } from './useSettings'
import NodeStatusBar, { STATUS_BAR_TEXT } from './NodeStatusBar'
import { __resetActivityForTests, noteClientMsg, noteServerMsg } from './nodeActivity.store'
import { __resetNodeStatusForTests } from './nodeStatus.store'
import { setConnection } from './ws.connection'
import { STALL_MS } from './nodeStatusBar.rules'

const clip = vi.hoisted(() => ({ write: vi.fn(async (_text: string) => true) }))
vi.mock('./clipboard', () => ({ writeClipboard: clip.write }))

const NOW = Date.now()
let reply: Record<string, NodeStatusInfo> = {}
const fetchMock = vi.fn(async (url: string) => {
  void url
  return new Response(JSON.stringify({ nodes: reply }), { status: 200, headers: { 'Content-Type': 'application/json' } })
})

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  setConnection({ phase: 'connected', attempt: 0 })
})
afterEach(() => {
  cleanup(); __resetActivityForTests(); __resetNodeStatusForTests(); fetchMock.mockClear(); clip.write.mockClear(); vi.unstubAllGlobals()
})

const bar = () => document.querySelector('footer.node-statusbar')
const item = (id: string) => document.querySelector(`[data-item="${id}"]`)?.textContent

describe('NodeStatusBar', () => {
  it('terminal: shows live/pid/uptime/size/cwd/output age from one batched fetch', async () => {
    reply = { t1: { live: true, pid: 4242, startedAt: NOW - 3_660_000 } }
    noteClientMsg({ t: 'open', id: 't1', cols: 120, rows: 40 })
    noteServerMsg({ t: 'output', id: 't1', data: 'x' }, undefined, NOW - 3000)
    render(<NodeStatusBar sessionId="t1" kind="terminal" cwd="/home/u/project-x" />)
    await waitFor(() => expect(item('pid')).toBe('pid 4242'))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/node-status?ids=t1')
    expect(item('state')).toBe('live')
    expect(item('uptime')).toBe('up 1h 1m')
    expect(item('size')).toBe('120×40')
    expect(item('cwd')).toBe('project-x')
    expect(item('output')).toMatch(/^out \ds$/)
    expect(bar()?.querySelectorAll('[data-anomaly]')).toHaveLength(0)
  })

  it('agent: agent items plus amber/red badges, announced politely, reachable by keyboard', async () => {
    reply = {
      a1: {
        live: true, pid: 7, startedAt: NOW - 60_000, status: 'working', statusSince: NOW - STALL_MS - 60_000, lastHookAt: NOW - STALL_MS - 1000,
        model: 'claude-opus-4-7', contextPct: 93.4, costUsd: 1.23456, outbox: { queued: 1, lastFailedAt: NOW - 10 },
        work: { title: 'Secret task title', status: 'running', startedAt: NOW - 120_000 },
      },
    }
    render(<NodeStatusBar sessionId="a1" kind="agent" cwd="/w" />)
    await waitFor(() => expect(item('model')).toBe('opus-4-7'))
    expect(item('agent')).toMatch(/^working 6m$/)
    expect(item('context')).toBe('ctx 93%')
    expect(item('cost')).toBe('$1.23')
    expect(item('task')).toBe('task running')
    expect(item('outbox')).toBe('outbox 1')
    const badges = [...document.querySelectorAll<HTMLButtonElement>('[data-anomaly]')]
    expect(badges.map((b) => [b.dataset.anomaly, b.dataset.level])).toEqual([['outbox', 'error'], ['stalled', 'warn'], ['context', 'warn']])
    expect(badges.every((b) => b.tagName === 'BUTTON')).toBe(true)
    const live = document.querySelector('[aria-live="polite"]')
    expect(live?.textContent).toContain('Context is 93% used')
    expect(bar()?.querySelector('[title]')).toBeNull() // tooltips, never native title=
  })

  it('click opens every field and Copy diagnostics copies JSON without the task title or full path', async () => {
    reply = { a2: { live: true, status: 'waiting', work: { title: 'Secret task title', status: 'running', startedAt: NOW } } }
    render(<NodeStatusBar sessionId="a2" kind="agent" cwd="/Users/someone/private/repo" />)
    await waitFor(() => expect(item('task')).toBe('task running'))
    fireEvent.click(document.querySelector('[data-item="task"]')!)
    const pop = document.querySelector('.node-statusbar__pop')
    expect(pop?.textContent).toContain('Secret task title') // the popover shows the full value
    fireEvent.click(screen.getByRole('button', { name: STATUS_BAR_TEXT.copy }))
    await waitFor(() => expect(document.querySelector('[data-action-result="ok"]')?.textContent).toContain(STATUS_BAR_TEXT.copied))
    const json = JSON.parse(clip.write.mock.calls[0][0]) as { node: string; fields: Record<string, string> }
    expect(json.node).toBe('a2')
    expect(json.fields.cwd).toBe('repo')
    expect(clip.write.mock.calls[0][0]).not.toContain('Secret task title')
    expect(clip.write.mock.calls[0][0]).not.toContain('/Users/someone')
  })

  it('a failed copy says so', async () => {
    clip.write.mockResolvedValueOnce(false)
    reply = { t3: { live: true } }
    render(<NodeStatusBar sessionId="t3" kind="terminal" />)
    await waitFor(() => expect(item('state')).toBe('live'))
    fireEvent.click(document.querySelector('[data-item="state"]')!)
    fireEvent.click(screen.getByRole('button', { name: STATUS_BAR_TEXT.copy }))
    await waitFor(() => expect(document.querySelector('[data-action-result="failed"]')?.textContent).toContain(STATUS_BAR_TEXT.noClipboard))
  })

  it('an unexpected exit and a reconnecting stream show red and amber badges', async () => {
    reply = { t4: { live: false } }
    noteServerMsg({ t: 'exit', id: 't4', code: 137 }, 'self')
    render(<NodeStatusBar sessionId="t4" kind="terminal" />)
    act(() => setConnection({ phase: 'reconnecting', attempt: 1 }))
    expect(item('state')).toBe('exited 137')
    expect([...document.querySelectorAll<HTMLElement>('[data-anomaly]')].map((b) => b.dataset.anomaly)).toEqual(['exit', 'stream'])
  })

  it('renders nothing and fetches nothing when the setting is off', async () => {
    render(<SettingsProvider value={{ ...DEFAULT_SETTINGS, nodeStatusBar: false }}><NodeStatusBar sessionId="t5" kind="terminal" /></SettingsProvider>)
    await new Promise((r) => setTimeout(r, 700))
    expect(bar()).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
