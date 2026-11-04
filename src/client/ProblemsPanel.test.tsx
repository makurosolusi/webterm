/** @vitest-environment jsdom */
// Problems panel DOM: rows open the file at the line, "Fix with agent" posts to the outbox route,
// Run starts the checks, and the status item carries the counts. fetch and Monaco are faked.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useEffect } from 'react'
import type { Node } from '@xyflow/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import './vscode/test-setup'

const reveal = vi.hoisted(() => vi.fn(async () => true))
vi.mock('./Omnibox.open', () => ({ revealFileLine: reveal }))

import ProblemsPanel, { agentTargets, problemLocation, useProblems } from './ProblemsPanel'

const STATE = {
  ran: true, running: true, tools: ['tsc'], errors: 1, warnings: 0, updatedAt: 5, total: 1,
  problems: [{ source: 'ts', file: '/w/src/a.ts', line: 12, column: 5, severity: 'error', code: 'TS2322', message: 'Type mismatch' }],
}

function stubFetch() {
  const calls: Array<{ url: string; body?: unknown }> = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    return new Response(JSON.stringify(url.startsWith('/api/problems/fix') ? { deduped: false } : STATE), { status: url.startsWith('/api/problems/fix') ? 202 : 200 })
  }))
  return calls
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks() })

const agents = [{ id: 'a1', type: 'agent', position: { x: 0, y: 0 }, data: { title: 'claude' } }] as Node[]

function Harness({ add, focus, onItems }: { add: (...a: unknown[]) => void; focus: (id: string) => void; onItems: (label: string) => void }) {
  const p = useProblems('ws1')
  useEffect(() => { p.setOpen(true) }, [])
  useEffect(() => { onItems(p.statusItems[0]?.label ?? '') }, [p.statusItems])
  return <ProblemsPanel problems={p} root="/w" nodes={agents} nodesRef={{ current: agents }} addFlowNode={add} onFocus={focus} />
}

describe('ProblemsPanel', () => {
  it('helpers: relative location and agent targets', () => {
    expect(problemLocation({ file: '/w/src/a.ts', line: 1, column: 2 }, '/w/')).toBe('src/a.ts:1:2')
    expect(agentTargets([...agents, { id: 't', type: 'terminal', position: { x: 0, y: 0 }, data: {} }] as Node[])).toEqual([{ id: 'a1', label: 'claude' }])
  })

  it('lists problems, opens the file at the line, fixes with the agent', async () => {
    const calls = stubFetch()
    const add = vi.fn()
    const labels: string[] = []
    render(<Harness add={add} focus={() => {}} onItems={(l) => labels.push(l)} />)
    const row = await screen.findByRole('button', { name: /Type mismatch/ })
    expect(labels).toContain('1 / 0')

    fireEvent.click(row)
    const make = add.mock.calls[0]![0] as () => { kind: string; filePath: string }
    expect(make()).toMatchObject({ kind: 'editor', filePath: '/w/src/a.ts' })
    expect(reveal).toHaveBeenCalledWith('/w/src/a.ts', 12, 5)

    fireEvent.click(screen.getByRole('button', { name: 'Fix with agent' }))
    await waitFor(() => expect(calls.some((c) => c.url.startsWith('/api/problems/fix'))).toBe(true))
    expect(calls.find((c) => c.url.startsWith('/api/problems/fix'))!.body).toEqual({ workspace: 'ws1', to: 'a1' })
  })

  it('Stop is offered while watching and posts stop', async () => {
    const calls = stubFetch()
    render(<Harness add={() => {}} focus={() => {}} onItems={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Stop watching' }))
    await waitFor(() => expect(calls.some((c) => c.url.startsWith('/api/problems/stop'))).toBe(true))
  })
})
