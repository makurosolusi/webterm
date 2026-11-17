/** @vitest-environment jsdom */
// SkillNode card in React Flow (jsdom): collapsed by default, one-line state per library state, the "Updated"
// badge and its dismissal, Unavailable for disabled / missing, retry on a failed lookup, remove via the node chrome.
// The library lookup is faked; React Flow only measures through the harness's ResizeObserver.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ReactFlow, ReactFlowProvider, useNodesState, type Node } from '@xyflow/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import './vscode/test-setup'
import type { CanvasSkillsLoad } from './skillNode.api'

const lib = vi.hoisted(() => ({ load: { status: 'loading' } as unknown, reload: vi.fn() }))
vi.mock('./skillNode.api', () => ({ useCanvasSkills: () => ({ ...(lib.load as object), reload: lib.reload }) }))

import SkillNode from './SkillNode'

beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

let latest: Node[] = []
function Canvas({ data }: { data: Record<string, unknown> }) {
  const [nodes, , onNodesChange] = useNodesState<Node>([{ id: 's1', type: 'skill', position: { x: 0, y: 0 }, width: 260, height: 44, data }])
  latest = nodes
  return <div style={{ width: 800, height: 600 }}><ReactFlowProvider><ReactFlow nodes={nodes} onNodesChange={onNodesChange} nodeTypes={{ skill: SkillNode }} /></ReactFlowProvider></div>
}
const show = (load: CanvasSkillsLoad, data: Record<string, unknown> = { skill: 'webterm-release', seenVersion: '2' }) => {
  lib.load = load
  render(<Canvas data={data} />)
}
const ready = (over: Partial<{ version: string; enabled: boolean; description: string }> = {}): CanvasSkillsLoad => ({ status: 'ready', skills: [{ name: 'webterm-release', version: '2', enabled: true, description: 'Ship a release.', ...over }] })
const byTitle = (t: string): Element => { const el = document.querySelector(`[data-title="${t}"]`); if (!el) throw new Error(`no header button "${t}"`); return el }
const expand = () => fireEvent.click(byTitle('Expand'))
const dataOf = () => latest[0].data as Record<string, unknown>

describe('SkillNode', () => {
  it('is collapsed by default: name and version, no description until expanded', async () => {
    show(ready())
    await waitFor(() => expect(screen.getByText('webterm-release')).toBeTruthy())
    expect(screen.getByText('v2')).toBeTruthy()
    expect(screen.queryByText('Ship a release.')).toBeNull()
    expand()
    expect(screen.getByText('Ship a release.')).toBeTruthy()
  })

  it('exposes the typed skill-out port on top', async () => {
    show(ready())
    await waitFor(() => expect(document.querySelector('[data-handleid="skill-out"]')).toBeTruthy())
    expect(document.querySelector('[data-handleid="skill-out"]')?.classList.contains('react-flow__handle-top')).toBe(true)
  })

  it('follows the ACTIVE version: a newer one shows "Updated v2 → v3" and a click dismisses it', async () => {
    show(ready({ version: '3' }))
    const badge = await screen.findByRole('button', { name: /active version changed/i })
    expect(badge.textContent).toContain('Updated v2 → v3')
    fireEvent.click(badge)
    await waitFor(() => expect(dataOf().seenVersion).toBe('3'))
    expect(screen.queryByRole('button', { name: /active version changed/i })).toBeNull()
  })

  it('records the version it first sees, so only a later change reads as updated', async () => {
    show(ready({ version: '5' }), { skill: 'webterm-release' })
    await waitFor(() => expect(dataOf().seenVersion).toBe('5'))
    expect(screen.queryByText(/Updated/)).toBeNull()
  })

  it('disabled: Unavailable badge and the reason; the node is not removed', async () => {
    show(ready({ enabled: false }))
    await waitFor(() => expect(screen.getByText('Unavailable')).toBeTruthy())
    expand()
    expect(screen.getByText(/Switched off in the library/)).toBeTruthy()
    expect(latest).toHaveLength(1)
  })

  it('missing: Unavailable with its own reason', async () => {
    show({ status: 'ready', skills: [] })
    await waitFor(() => expect(screen.getByText('Unavailable')).toBeTruthy())
    expand()
    expect(screen.getByText(/Not in the library any more/)).toBeTruthy()
  })

  it('loading, failed (with Retry) and Central-skills-off each say so', async () => {
    show({ status: 'loading' })
    expand()
    expect(screen.getByRole('status').textContent).toContain('Loading skill')
    cleanup()
    show({ status: 'error' })
    expand()
    expect(screen.getByRole('alert').textContent).toContain('Could not load this skill')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(lib.reload).toHaveBeenCalledTimes(1)
    cleanup()
    show({ status: 'off' })
    expect(screen.getByText('Unavailable')).toBeTruthy()
    expand()
    expect(screen.getByText(/Central skills are off/)).toBeTruthy()
  })

  it('removes itself through the node chrome', async () => {
    show(ready())
    await waitFor(() => expect(screen.getByText('webterm-release')).toBeTruthy())
    fireEvent.click(byTitle('Remove skill node'))
    await waitFor(() => expect(latest).toHaveLength(0))
  })
})
