/** @vitest-environment jsdom */
// "Show on canvas" on Central tool cards: only for acting tools that name a node, and it is the same reveal as the tray's Show.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ReactFlowProvider, type Node, type ReactFlowInstance } from '@xyflow/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import CentralActMount from '../centralAct.layer'
import { resetSharedActStore, setShowNodeHandler } from '../centralAct.store'
import { ACT_SHOW_TOOLS, actNodeId, ToolCard, type ToolPart } from './chatToolGroup'

afterEach(() => { cleanup(); resetSharedActStore(); setShowNodeHandler(null) })

const part = (name: string, data: unknown, state: ToolPart['state'] = 'succeeded'): ToolPart =>
  ({ type: 'tool', toolCallId: `c-${name}`, name, state, result: { outcome: 'ok', detail: 'ok', data } })

describe('actNodeId (receipt shapes from toolAct.ts nodesOf)', () => {
  it.each([
    ['agent_spawn', { nodeId: 'n1' }, 'n1'], ['agent_prompt', { nodeId: 'n1' }, 'n1'], ['agent_relay', { nodeId: 'n1' }, 'n1'],
    ['canvas_open', { ids: ['e1', 'e2'] }, 'e1'], ['canvas_type', { nodeId: 't1' }, 't1'], ['canvas_edit', { wired: [['a', 'b']] }, 'a'],
    ['browser_open', { nodeId: 'br', agentNode: 'ag' }, 'br'], ['browser_act', { nodeId: 'br' }, 'br'], ['browser_read', { nodeId: 'br', host: 'example.com' }, 'br'],
['chat_send', { nodeId: 'c1' }, 'c1'],
    ['permission_decide', { nodeId: 'p1' }, 'p1'], ['task_assign', { nodeId: 'k1' }, 'k1'], ['chat_config', { nodeId: 'c1' }, 'c1'], ['chat_mode', { nodeId: 'c1' }, 'c1'],
  ])('%s -> node', (name, data, id) => { expect(actNodeId(part(name, data))).toBe(id) })

  it('is null for a non-acting tool, a closing tool, a failed call, or a receipt without a node', () => {
    expect(actNodeId(part('node_list', { nodeId: 'n1' }))).toBeNull()
    expect(actNodeId(part('canvas_close', { ids: ['n1'] }))).toBeNull()
    expect(actNodeId(part('agent_close', { nodeId: 'n1' }))).toBeNull()
    expect(actNodeId(part('canvas_type', { nodeId: 'n1' }, 'failed'))).toBeNull()
    expect(actNodeId(part('agent_relay', { mailId: 'm' }))).toBeNull()
    expect(actNodeId(part('browser_read', { host: 'example.com' }))).toBeNull()
    expect(actNodeId({ ...part('browser_read', null), result: { ok: false, code: 'reader_unavailable' } })).toBeNull()
    expect(actNodeId(part('browser_read', { nodeId: 'br' }, 'failed'))).toBeNull()
    expect(actNodeId({ ...part('canvas_type', null), result: undefined })).toBeNull()
  })

  it('the client list equals the server ACT_TOOLS minus the tools that close a node', () => {
    const src = readFileSync(join(__dirname, '../../server/central/tools/toolAct.ts'), 'utf8')
    const block = /ACT_TOOLS[^=]*=\s*\{([\s\S]*?)\n\}/.exec(src)?.[1] ?? ''
    const server = [...block.matchAll(/'?([\w.]+)'?:\s*'(\w+)'/g)].filter((m) => m[2] !== 'closed').map((m) => m[1]!.replace(/\./g, '_'))
    expect(server.length).toBeGreaterThanOrEqual(11)
    expect([...ACT_SHOW_TOOLS].sort()).toEqual(server.sort())
  })
})

describe('ToolCard button', () => {
  it('appears only for an acting tool with a node, and calls the registered reveal with that node', () => {
    const reveal = vi.fn(() => true)
    setShowNodeHandler(reveal)
    const { rerender } = render(<ToolCard part={part('node_list', { nodeId: 'n1' })} />)
    expect(screen.queryByRole('button', { name: 'Show on canvas' })).toBeNull()
    rerender(<ToolCard part={part('canvas_type', { nodeId: 'n1' })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Show on canvas' }))
    expect(reveal).toHaveBeenCalledWith('n1')
  })

  it('goes through revealNode on the mounted canvas (fitView for an off-screen node) and disables itself for a node not on the board', () => {
    const far: Node = { id: 'far', position: { x: 90_000, y: 90_000 }, data: {} }
    const rf = { getViewport: () => ({ x: 0, y: 0, zoom: 1 }), fitView: vi.fn(), setNodes: vi.fn(), getNode: (id: string) => (id === 'far' ? far : undefined) }
    render(<><ReactFlowProvider><CentralActMount rf={{ current: rf as unknown as ReactFlowInstance }} nodes={[far]} workspaceId="w1" /></ReactFlowProvider>
      <ToolCard part={part('canvas_type', { nodeId: 'far' })} /><ToolCard part={{ ...part('canvas_type', { nodeId: 'gone' }), toolCallId: 'c2' }} /></>)
    const [first, second] = screen.getAllByRole('button', { name: 'Show on canvas' })
    fireEvent.click(first!)
    expect(rf.fitView).toHaveBeenCalledTimes(1)
    fireEvent.click(second!)
    expect((screen.getByRole('button', { name: 'Node not on this board' }) as HTMLButtonElement).disabled).toBe(true)
  })
})
