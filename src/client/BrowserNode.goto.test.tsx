/** @vitest-environment jsdom */
// URL awal node browser: tepat satu `nav go` setelah state pertama bila sesi kosong, dan mirror
// state.url -> data.url tidak boleh menimpa dengan about:blank. Stream dipalsukan; tanpa Chromium.
import type { ComponentProps } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import './vscode/test-setup'
import type { BrowserState, ClientMsg } from '../shared/browser.contract'
import type { BrowserListener } from './browser.stream'

const fake = vi.hoisted(() => {
  const state = { listener: null as null | BrowserListener, sent: [] as unknown[], updates: [] as unknown[] }
  return {
    state,
    stream: {
      subscribe: (_id: string, l: BrowserListener) => { state.listener = l; return () => undefined },
      attach: () => undefined,
      resize: () => undefined,
      setAudio: () => undefined, detach: () => undefined,
      send: (m: ClientMsg) => { state.sent.push(m) },
    },
  }
})
vi.mock('./browser.stream', () => ({ browserStream: fake.stream }))
// updateNodeData dipalsukan: node tidak ada di store RF, kita hanya perlu tahu apa yang ditulis.
vi.mock('@xyflow/react', async (orig) => {
  const actual = await orig<typeof import('@xyflow/react')>()
  return { ...actual, useReactFlow: () => ({ ...actual.useReactFlow(), updateNodeData: (_id: string, d: unknown) => { fake.state.updates.push(d) } }) }
})

import BrowserNode from './BrowserNode'
import { isBlankUrl, shouldMirrorUrl } from './browser.useGoto'

const WANT = 'https://example.com/a'
const st = (over: Partial<BrowserState> = {}): { t: 'state' } & BrowserState => ({
  t: 'state', id: 'b1', url: '', title: '', loading: false, canBack: false, canForward: false,
  lease: 'human', live: 'live', ...over,
} as { t: 'state' } & BrowserState)

const props = (data: { url?: string }) =>
  ({ id: 'b1', data, selected: false }) as unknown as ComponentProps<typeof BrowserNode>
const tree = (data: { url?: string }) => (
  <ReactFlowProvider><BrowserNode {...props(data)} /></ReactFlowProvider>
)
const mount = (data: { url?: string } = { url: WANT }) => render(tree(data))
const push = (m: ReturnType<typeof st>) => act(() => fake.state.listener?.onMsg(m))
const gos = () => fake.state.sent.filter((m) => (m as { t: string; action?: string }).t === 'nav')

beforeEach(() => {
  fake.state.listener = null; fake.state.sent = []; fake.state.updates = []
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('useGoto di BrowserNode', () => {
  it('state kosong + data.url -> tepat satu nav go dengan url itu', () => {
    mount()
    push(st({ url: '' }))
    expect(gos()).toEqual([{ t: 'nav', action: 'go', url: WANT, id: 'b1' }])
  })

  it('about:blank juga memicu', () => {
    mount()
    push(st({ url: 'about:blank' }))
    expect(gos()).toHaveLength(1)
  })

  it('state sudah ber-URL -> nol kirim', () => {
    mount()
    push(st({ url: 'https://example.com/saved' }))
    expect(gos()).toHaveLength(0)
  })

  it('blocked -> nol kirim', () => {
    mount()
    push(st({ url: '', blocked: 'private_host' as never }))
    expect(gos()).toHaveLength(0)
  })

  it('belum ada state (belum attach) -> nol kirim', () => {
    mount()
    expect(gos()).toHaveLength(0)
  })

  it('tanpa data.url -> nol kirim', () => {
    mount({})
    push(st({ url: '' }))
    expect(gos()).toHaveLength(0)
  })

  it('tetap satu kirim lintas re-render dan state kosong berulang', () => {
    const r = mount()
    push(st({ url: '' }))
    r.rerender(tree({ url: WANT }))
    push(st({ url: 'about:blank' }))
    r.rerender(tree({ url: WANT }))
    r.rerender(tree({ url: 'https://example.com/lain' }))
    push(st({ url: '', loading: true }))
    expect(gos()).toHaveLength(1)
  })
})

describe('mirror state.url -> data.url', () => {
  it('about:blank tidak ditulis ke data.url', () => {
    mount()
    push(st({ url: 'about:blank' }))
    expect(fake.state.updates).toEqual([])
  })

  it('URL nyata tetap ditulis (regresi)', () => {
    mount({ url: WANT })
    push(st({ url: 'https://example.com/b' }))
    expect(fake.state.updates).toEqual([{ url: 'https://example.com/b' }])
  })

  it('shouldMirrorUrl: loading, blocked, sama, kosong, blank -> false', () => {
    expect(shouldMirrorUrl(undefined, 'x')).toBe(false)
    expect(shouldMirrorUrl(st({ url: 'https://a.test/', loading: true }), undefined)).toBe(false)
    expect(shouldMirrorUrl(st({ url: 'https://a.test/', blocked: 'private_host' as never }), undefined)).toBe(false)
    expect(shouldMirrorUrl(st({ url: 'https://a.test/' }), 'https://a.test/')).toBe(false)
    expect(shouldMirrorUrl(st({ url: '' }), undefined)).toBe(false)
    expect(shouldMirrorUrl(st({ url: 'about:blank' }), undefined)).toBe(false)
    expect(shouldMirrorUrl(st({ url: 'https://a.test/' }), undefined)).toBe(true)
  })

  it('isBlankUrl', () => {
    expect([isBlankUrl(''), isBlankUrl(undefined), isBlankUrl(null), isBlankUrl('about:blank')]).toEqual([true, true, true, true])
    expect(isBlankUrl('https://a.test/')).toBe(false)
  })
})
