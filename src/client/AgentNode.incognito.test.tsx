/**
 * @vitest-environment jsdom
 */
// The agent node's right-click menu carries the incognito switch (F5-a follow-up, F5-b): the row sends the
// same PUT as Settings › Memory and its label follows the shared incognito state. Real canvas (canvasHarness).
import { fireEvent, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { MEMORY_TEXT } from './AgentMemory'
import { installCanvasDom, mountCanvas, unmountCanvas } from './canvasHarness'
import type { WsNode } from '../shared/workspace'

const agentNode: WsNode = { id: 'agent-1', kind: 'agent', x: 0, y: 0, width: 420, height: 320, cmd: 'echo hi', agentId: 'claude', cwd: '/', title: 'agent' }
const menu = (): HTMLElement | null => document.querySelector('[role="menu"][data-slot="vscode-menu"]')
const row = (label: string): HTMLElement | undefined =>
  Array.from(menu()?.querySelectorAll('button') ?? []).find((b) => b.textContent === label) as HTMLElement | undefined

async function openMenu(): Promise<void> {
  const body = document.querySelector('.react-flow__node-agent .node-body')
  if (!body) throw new Error('agent node body not rendered')
  fireEvent.contextMenu(body, { clientX: 300, clientY: 220 })
  await waitFor(() => expect(menu()).not.toBeNull())
}

beforeAll(installCanvasDom)
afterEach(() => { unmountCanvas(); vi.restoreAllMocks() })

it('Go incognito sends the incognito PUT for this node, then the row offers Leave incognito', async () => {
  await mountCanvas({ nodes: [agentNode], dirs: {} })
  const inner = globalThis.fetch
  const puts: unknown[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === '/api/memory2/incognito' && init?.method === 'PUT') {
      const body = JSON.parse(String(init.body)) as { nodeId: string; on: boolean }
      puts.push(body)
      return new Response(JSON.stringify({ refs: body.on ? [`node:${body.nodeId}`] : [] }))
    }
    return inner(input, init)
  }))
  await openMenu()
  const go = row(MEMORY_TEXT.goIncognito)
  expect(go).toBeDefined()
  fireEvent.pointerDown(go!)
  fireEvent.click(go!)
  await waitFor(() => expect(puts).toEqual([{ nodeId: 'agent-1', on: true }]))
  await openMenu()
  await waitFor(() => expect(row(MEMORY_TEXT.leaveIncognito)).toBeDefined())
})
