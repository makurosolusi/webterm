/** @vitest-environment jsdom */
// Handle menu hook + view in jsdom: open on click / pane release, search, keyboard, disabled rows, Esc,
// and spawn -> node + cable with the right ends. React Flow itself is not mounted (its events are called directly).
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import type { Node } from '@xyflow/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useHandleMenu } from './handleMenu.hook'
import type { HandleSpawners } from './handleMenu.model'
import { DEFAULT_SETTINGS } from '../shared/settings'

afterEach(() => { cleanup(); frame.mockClear() })

const agentNode: Node = { id: 'a1', type: 'agent', position: { x: 0, y: 0 }, width: 400, height: 300, data: { agentId: 'claude' } }
const startParams = (handleId: string, handleType: 'source' | 'target') => ({ nodeId: 'a1', handleId, handleType }) as never
const ev = (x: number, y: number, target?: Element) => ({ clientX: x, clientY: y, target: target ?? null }) as unknown as MouseEvent
const mdown = (x: number, y: number) => ({ clientX: x, clientY: y }) as MouseEvent
const noTarget = { isValid: null } as never

interface Api { start: (e: MouseEvent, p: never) => void; end: (e: MouseEvent, s: never) => void }
let api: Api
let spawn: HandleSpawners
const frame = vi.fn()
let addNode: (n: Node) => void
const fn = (f: unknown) => f as ReturnType<typeof vi.fn>

function Host({ s }: { s: HandleSpawners | undefined }) {
  const [nodes, setNodes] = useState<Node[]>([agentNode])
  addNode = (n) => setNodes((p) => [...p, n])
  const m = useHandleMenu({ frame, nodes, settings: DEFAULT_SETTINGS, spawn: s })
  api = { start: m.onConnectStart as never, end: m.onConnectEnd as never }
  return <>{m.menu}</>
}

function mount(over: Partial<HandleSpawners> = {}, none = false) {
  spawn = { addTerminal: vi.fn(), addFiles: vi.fn(), addAgent: vi.fn(), addBrowser: vi.fn(), addDiff: vi.fn(), addAgentChat: vi.fn(), link: vi.fn(), ...over }
  render(<Host s={none ? undefined : spawn} />)
}
const click = (type: 'source' | 'target' = 'source') => act(() => {
  api.start(mdown(300, 200), startParams(type === 'source' ? 'link-out' : 'link-in', type))
  api.end(ev(301, 200), noTarget)
})

describe('handle menu', () => {
  it('opens on a click with a focused search box, a labelled dialog and a listbox', () => {
    mount()
    expect(screen.queryByRole('dialog')).toBeNull()
    click()
    expect(screen.getByRole('dialog', { name: 'Add connected node' })).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole('combobox'))
    expect(screen.getByRole('listbox')).toBeTruthy()
    expect(screen.getAllByRole('option').length).toBeGreaterThan(0)
    expect(screen.getByText('Nodes')).toBeTruthy()
  })

  it('does not open for a drag released on a node, nor when a cable was made, nor without spawners', () => {
    mount()
    act(() => { api.start(mdown(300, 200), startParams('link-out', 'source')); api.end(ev(500, 500, document.body), noTarget) })
    expect(screen.queryByRole('dialog')).toBeNull()
    act(() => { api.start(mdown(300, 200), startParams('link-out', 'source')); api.end(ev(301, 200), { isValid: true } as never) })
    expect(screen.queryByRole('dialog')).toBeNull()
    cleanup()
    mount({}, true)
    click()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('opens on a cable released on the empty pane', () => {
    mount()
    const pane = document.body.appendChild(document.createElement('div'))
    pane.className = 'react-flow__pane'
    act(() => { api.start(mdown(300, 200), startParams('link-out', 'source')); api.end(ev(600, 400, pane), noTarget) })
    expect(screen.getByRole('dialog')).toBeTruthy()
    pane.remove()
  })

  it('ignores handles that are not bridge handles', () => {
    mount()
    act(() => { api.start(mdown(1, 1), { nodeId: 'a1', handleId: 'other', handleType: 'source' } as never); api.end(ev(1, 1), noTarget) })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('filters by search, shows "No match", and Esc closes', () => {
    mount()
    click()
    const input = screen.getByRole('combobox')
    fireEvent.change(input, { target: { value: 'diff' } })
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([expect.stringContaining('Diff')])
    fireEvent.change(input, { target: { value: 'zzzzqq' } })
    expect(screen.getByText('No match')).toBeTruthy()
    expect(screen.queryAllByRole('option')).toHaveLength(0)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('arrow keys move the active row and Enter spawns it to the right of the origin', () => {
    mount()
    click()
    const input = screen.getByRole('combobox')
    const opts = () => screen.getAllByRole('option')
    expect(opts()[0].getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(opts()[1].getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.queryByRole('dialog')).toBeNull()
    const called = [spawn.addAgent, spawn.addBrowser, spawn.addDiff, spawn.addAgentChat].map(fn).find((f) => f.mock.calls.length > 0)
    expect(called).toBeDefined()
    const at = called!.mock.calls[0].at(-1)
    expect(at.x - DEFAULT_SETTINGS.defaultNodeWidth / 2).toBeGreaterThan(400)
  })

  it('cables origin -> new for a source handle, new -> origin for a target handle, once the node appears', () => {
    mount()
    click('source')
    fireEvent.click(screen.getByRole('option', { name: /Diff/ }))
    expect(spawn.link).not.toHaveBeenCalled()
    act(() => addNode({ id: 'd1', type: 'diff', position: { x: 500, y: 0 }, data: {} }))
    expect(spawn.link).toHaveBeenCalledTimes(1)
    expect(spawn.link).toHaveBeenCalledWith(expect.objectContaining({ source: 'a1', target: 'd1' }))
    expect(frame).toHaveBeenCalledWith(['a1', 'd1'])

    click('target')
    fireEvent.click(screen.getByRole('option', { name: /Diff/ }))
    act(() => addNode({ id: 'd2', type: 'diff', position: { x: -500, y: 0 }, data: {} }))
    expect(spawn.link).toHaveBeenLastCalledWith(expect.objectContaining({ source: 'd2', target: 'a1' }))
    const at = fn(spawn.addDiff).mock.calls[1][0]
    expect(at.x + DEFAULT_SETTINGS.defaultNodeWidth / 2).toBeLessThan(0)
  })

  it('disabled rows show their reason and cannot be picked', () => {
    mount({ addBrowser: undefined })
    click()
    const row = screen.getByRole('option', { name: /^New Browser/ })
    expect(row.getAttribute('aria-disabled')).toBe('true')
    expect(row.textContent).toContain('Browser is turned off')
    fireEvent.click(row)
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(spawn.link).not.toHaveBeenCalled()
  })
})
