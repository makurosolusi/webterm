/** @vitest-environment jsdom */
// Problems panel DOM: rows open the file at the line, "Fix with agent" posts to the outbox route,
// Run starts the checks, and the status item carries the counts. fetch and Monaco are faked.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useEffect } from 'react'
import type { Node } from '@xyflow/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import './vscode/test-setup'

const openAt = vi.hoisted(() => vi.fn())
vi.mock('./Omnibox.open', () => ({ openEditorAt: openAt }))

import ProblemsPanel, { agentTargets, mergeProblems, problemLocation, useProblems } from './ProblemsPanel'
import { setLspProblems } from './editorLsp.store'

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

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); setLspProblems('/w/src/b.ts', []) })

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
    expect(openAt).toHaveBeenCalledWith(expect.objectContaining({ addFlowNode: add }), '/w/src/a.ts', 12, 5)

    fireEvent.click(screen.getByRole('button', { name: 'Fix with agent' }))
    await waitFor(() => expect(calls.some((c) => c.url.startsWith('/api/problems/fix'))).toBe(true))
    expect(calls.find((c) => c.url.startsWith('/api/problems/fix'))!.body).toEqual({ workspace: 'ws1', to: 'a1' })
  })

  it('live language-server diagnostics join the list and the counter, deduped against the run', async () => {
    stubFetch()
    setLspProblems('/w/src/b.ts', [{ source: 'Pyright', file: '/w/src/b.ts', line: 3, column: 1, severity: 'error', message: 'Undefined name' }])
    const labels: string[] = []
    render(<Harness add={() => {}} focus={() => {}} onItems={(l) => labels.push(l)} />)
    await screen.findByRole('button', { name: /Type mismatch/ }) // the run has loaded; rows are final
    fireEvent.click(screen.getByRole('button', { name: /Undefined name/ }))
    expect(openAt).toHaveBeenCalledWith(expect.anything(), '/w/src/b.ts', 3, 1)
    await waitFor(() => expect(labels.at(-1)).toBe('2 / 0'))
    const run = STATE.problems as Parameters<typeof mergeProblems>[0]
    expect(mergeProblems(run, [{ ...run[0]!, source: 'ts' }])).toHaveLength(1)
  })

  it('Stop is offered while watching and posts stop', async () => {
    const calls = stubFetch()
    render(<Harness add={() => {}} focus={() => {}} onItems={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Stop watching' }))
    await waitFor(() => expect(calls.some((c) => c.url.startsWith('/api/problems/stop'))).toBe(true))
  })
})
