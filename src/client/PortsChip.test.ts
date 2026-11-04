import { describe, expect, it, vi } from 'vitest'
import type { DetectedPort } from '../server/ports/ports.service'
import { fetchPorts, portChipLabel, portChipRequest, portStatusItems } from './PortsChip'

const PORT: DetectedPort = { port: 5173, host: '*', url: 'http://localhost:5173', pid: 1, processName: 'node', nodeId: 'n1', workspaceId: 'ws1', nodeLabel: 'brisk-otter' }

describe('ports chips', () => {
  it('labels a chip "localhost:5173 (brisk-otter)"', () => {
    expect(portChipLabel(PORT)).toBe('localhost:5173 (brisk-otter)')
  })

  it('clicking a chip opens the URL in a Browser node beside the owning terminal', () => {
    const open = vi.fn(() => ({ status: 'created' as const, nodeId: 'b1' }))
    const [item] = portStatusItems([PORT], open)
    item!.onClick!()
    expect(open).toHaveBeenCalledWith({ url: 'http://localhost:5173', anchorNodeId: 'n1' })
    expect(portChipRequest(PORT)).toEqual({ url: 'http://localhost:5173', anchorNodeId: 'n1' })
  })

  it('a chip without the browser feature is not clickable and says why', () => {
    const [item] = portStatusItems([PORT])
    expect(item!.onClick).toBeUndefined()
    expect(item!.tooltip).toContain('Browser node is off')
  })

  it('caps the number of chips', () => {
    expect(portStatusItems(Array.from({ length: 9 }, (_, i) => ({ ...PORT, port: 3000 + i })))).toHaveLength(4)
  })

  it('fetches the workspace list and names the failure', async () => {
    const ok = vi.fn(async () => new Response(JSON.stringify({ ports: [PORT] })))
    expect(await fetchPorts('ws1', ok as unknown as typeof fetch)).toEqual([PORT])
    expect(String((ok.mock.calls[0] as unknown[])[0])).toBe('/api/ports?workspace=ws1')
    const bad = vi.fn(async () => new Response('', { status: 503 }))
    await expect(fetchPorts('ws1', bad as unknown as typeof fetch)).rejects.toThrow('Load detected ports: HTTP 503')
  })
})
