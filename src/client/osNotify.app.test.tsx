/** @vitest-environment jsdom */
// App wiring for notification click: the focus hook App installs must be `onFocus`, which switches
// to the workspace that owns the node — a notification is most often about ANOTHER board.
import { waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { WsNode } from '../shared/workspace'
import { harnessWorkspace, installCanvasDom, mountCanvas, unmountCanvas } from './canvasHarness'
import * as osNotify from './osNotify'

const here: WsNode = { id: 'files-here', kind: 'files', x: 0, y: 0, width: 420, height: 320, dirPath: '/p', title: 'here' }
const there: WsNode = { id: 'files-there', kind: 'files', x: 2000, y: 0, width: 420, height: 320, dirPath: '/q', title: 'there' }

beforeAll(installCanvasDom)
afterEach(() => {
  unmountCanvas()
  vi.restoreAllMocks()
})

describe('notification click (App wiring)', () => {
  it('switches to the owning workspace and shows the node; in-board inView stays installed', async () => {
    const install = vi.spyOn(osNotify, 'setNotifyCanvas')
    await mountCanvas({
      nodes: [here],
      dirs: { '/p': [], '/q': [] },
      others: [harnessWorkspace({ id: 'ws-other', name: 'Other', nodes: [there] })],
    })
    const focus = install.mock.calls.map(([h]) => h.focus).filter(Boolean).at(-1)
    const inView = install.mock.calls.map(([h]) => h.inView).filter(Boolean).at(-1)
    expect(focus).toBeTypeOf('function')
    expect(inView).toBeTypeOf('function')
    expect(document.querySelector('.react-flow__node[data-id="files-there"]')).toBeNull()

    focus!('files-there')

    await waitFor(() => expect(document.querySelector('.react-flow__node[data-id="files-there"]')).not.toBeNull())
    expect(document.querySelector('.react-flow__node[data-id="files-here"]')).toBeNull()
    const puts = vi.mocked(globalThis.fetch).mock.calls.filter(([u, init]) => String(u) === '/api/active' && init?.method === 'PUT')
    expect(puts.length).toBeGreaterThan(0)
  })
})
