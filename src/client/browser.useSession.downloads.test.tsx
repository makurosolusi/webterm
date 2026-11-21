/** @vitest-environment jsdom */
// The node's socket carries downloads: the attach list replaces, a change upserts, and a node starts with none.
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { DownloadItem } from '../shared/browser.downloads'
import type { BrowserListener, BrowserStream } from './browser.stream'
import { useBrowserSession } from './browser.useSession'

let listener: BrowserListener | null = null
const stream: BrowserStream = {
  subscribe: (_id, l) => { listener = l; return () => undefined },
  attach: () => undefined, resize: () => undefined, detach: () => undefined, send: () => undefined, reset: () => undefined, setAudio: () => undefined,
}
let seen: DownloadItem[] = []
function Probe() {
  seen = useBrowserSession('b1', true, stream).downloads
  return null
}
const item = (id: string, received = 0): DownloadItem => ({ id, nodeId: 'b1', name: `${id}.zip`, url: '', host: 'h', received, total: 100, state: 'inProgress', risky: false, startedAt: 1 })
afterEach(() => { cleanup(); listener = null; seen = [] })

describe('session downloads', () => {
  it('starts empty, takes the attach list, then folds single changes', () => {
    render(<Probe />)
    expect(seen).toEqual([])
    act(() => listener?.onMsg({ t: 'downloads', id: 'b1', items: [item('a')] }))
    expect(seen.map((i) => i.id)).toEqual(['a'])
    act(() => listener?.onMsg({ t: 'download', id: 'b1', item: item('a', 40) }))
    act(() => listener?.onMsg({ t: 'download', id: 'b1', item: item('b') }))
    expect(seen.map((i) => [i.id, i.received])).toEqual([['a', 40], ['b', 0]])
    act(() => listener?.onMsg({ t: 'downloads', id: 'b1', items: [] }))
    expect(seen).toEqual([])
  })
})
