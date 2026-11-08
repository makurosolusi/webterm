/** @vitest-environment jsdom */
// On the real App: an unnamed node gets its name in the header and in the next save; a named one keeps it.
import { waitFor } from '@testing-library/react'
import { afterEach, beforeAll, expect, it } from 'vitest'
import { installCanvasDom, mountCanvas, unmountCanvas } from './canvasHarness'
import { withNodeNames } from '../shared/nodeNames'
import type { WsNode } from '../shared/workspace'

beforeAll(installCanvasDom)
afterEach(unmountCanvas)

const NODES: WsNode[] = [
  { id: 'f-named', kind: 'files', x: 0, y: 0, dirPath: '/', name: 'Mango', title: 'docs' },
  { id: 'f-new', kind: 'files', x: 500, y: 0, dirPath: '/' },
]
const expected = withNodeNames(NODES)[1].name

const header = (id: string) => document.querySelector(`.react-flow__node[data-id="${id}"] .node-title`)?.textContent

it('names the unnamed node, shows "name · label", and persists the name', async () => {
  await mountCanvas({ nodes: NODES, dirs: { '/': [] } })
  expect(header('f-named')).toBe('Mango · docs')
  await waitFor(() => expect(header('f-new')).toBe(expected))
  const saved = await waitFor(() => {
    const put = (fetch as unknown as { mock: { calls: [RequestInfo | URL, RequestInit | undefined][] } }).mock.calls
      .filter(([, init]) => init?.method === 'PUT').pop()
    if (!put) throw new Error('no save yet')
    return JSON.parse(String(put[1]?.body)) as { nodes: WsNode[] }
  }, { timeout: 3000 })
  expect(saved.nodes.map((n) => n.name)).toEqual(['Mango', expected])
})
