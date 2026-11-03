import { describe, expect, it } from 'vitest'
import { URL_MAX_CHARS } from '../shared/browser.contract'
import { browserDedupeKey, planBrowserOpen, type PlanNode } from './browser.open.plan'
import { BROWSER_OPEN_SIZE } from './browser.open.place'

const C = { x: 500, y: 300 }
const br = (id: string, url?: string): PlanNode => ({ id, type: 'browser', position: { x: 0, y: 0 }, data: { url } })

describe('browserDedupeKey', () => {
  it('membuang fragmen dan menyatukan alias loopback', () => {
    expect(browserDedupeKey('HTTP://LocalHost:3000/a#x')).toBe(browserDedupeKey('http://127.0.0.1:3000/a'))
    expect(browserDedupeKey('http://[::1]:3000/')).toBe('http://localhost:3000/')
    expect(browserDedupeKey('http://0.0.0.0:3000/')).toBe('http://localhost:3000/')
  })
  it('mempertahankan query, trailing slash, dan skema', () => {
    expect(browserDedupeKey('https://a.com/p?q=1')).not.toBe(browserDedupeKey('https://a.com/p'))
    expect(browserDedupeKey('https://a.com/a')).not.toBe(browserDedupeKey('https://a.com/a/'))
    expect(browserDedupeKey('http://a.com/')).not.toBe(browserDedupeKey('https://a.com/'))
    expect(browserDedupeKey('https://a.com')).toBe(browserDedupeKey('https://a.com/'))
  })
  it('port bawaan dibuang, port lain dipertahankan', () => {
    expect(browserDedupeKey('https://a.com:443/')).toBe(browserDedupeKey('https://a.com/'))
    expect(browserDedupeKey('https://a.com:8443/')).not.toBe(browserDedupeKey('https://a.com/'))
  })
  it('URL tak valid -> null', () => {
    for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'http://u:p@h.com', '', 'x'.repeat(URL_MAX_CHARS + 1)])
      expect(browserDedupeKey(bad)).toBeNull()
  })
})

describe('planBrowserOpen', () => {
  it('URL cocok -> reuse node browser PERTAMA', () => {
    const nodes = [br('b1', 'https://a.com/x'), br('b2', 'https://a.com/x#frag')]
    expect(planBrowserOpen(nodes, { url: 'https://a.com/x' }, 'new', C)).toEqual({ kind: 'reuse', nodeId: 'b1' })
  })
  it('data.url kosong/tak valid tidak cocok; node non-browser diabaikan', () => {
    const nodes: PlanNode[] = [
      br('e1', ''),
      br('e2', undefined),
      br('e3', 'file:///x'),
      { id: 't1', type: 'terminal', position: { x: 0, y: 0 }, data: { url: 'https://a.com/' } },
    ]
    const p = planBrowserOpen(nodes, { url: 'https://a.com/' }, 'new', C)
    expect(p.kind).toBe('create')
  })
  it('URL tak valid -> invalid dengan reason dari parseBrowserUrl', () => {
    expect(planBrowserOpen([], { url: 'file:///x' }, 'n', C)).toEqual({ kind: 'invalid', reason: 'scheme' })
    expect(planBrowserOpen([], { url: 'nope' }, 'n', C)).toEqual({ kind: 'invalid', reason: 'invalid' })
    expect(planBrowserOpen([], { url: 'http://u:p@h.com' }, 'n', C)).toEqual({ kind: 'invalid', reason: 'userinfo' })
    expect(planBrowserOpen([], { url: 'https://a.com/' + 'x'.repeat(URL_MAX_CHARS) }, 'n', C)).toEqual({
      kind: 'invalid',
      reason: 'too_long',
    })
  })
  it('create memakai parsed.url (bukan kunci kanonik) dan ukuran 640x400', () => {
    const p = planBrowserOpen([], { url: 'http://127.0.0.1:3000/a#x' }, 'new1', C)
    expect(p.kind).toBe('create')
    if (p.kind !== 'create') return
    expect(p.url).toBe('http://127.0.0.1:3000/a#x')
    expect(p.nodeId).toBe('new1')
    expect(p.size).toEqual(BROWSER_OPEN_SIZE)
  })
  it('anchor -> posisi di kanan anchor; at eksplisit mengalahkan anchor', () => {
    const anchor: PlanNode = { id: 'term', type: 'terminal', position: { x: 100, y: 50 }, measured: { width: 400, height: 300 } }
    const right = planBrowserOpen([anchor], { url: 'https://a.com/', anchorNodeId: 'term' }, 'n', C)
    expect(right).toMatchObject({ kind: 'create', position: { x: 532, y: 50 } })
    const at = planBrowserOpen([anchor], { url: 'https://a.com/', anchorNodeId: 'term', at: { x: 7, y: 9 } }, 'n', C)
    expect(at).toMatchObject({ kind: 'create', position: { x: 7, y: 9 } })
  })
  it('tanpa anchor -> sekitar tengah pandangan', () => {
    const p = planBrowserOpen([], { url: 'https://a.com/' }, 'n', C)
    expect(p).toMatchObject({ kind: 'create', position: { x: 500 - 320, y: 300 - 200 } })
  })
})
