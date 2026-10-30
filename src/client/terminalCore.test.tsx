/**
 * @vitest-environment jsdom
 */
// TerminalCore di canvas sungguhan: wheel, kapan `open` dikirim, dan dedupe `resize`.
import { waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { installCanvasDom, mountCanvas, unmountCanvas } from './canvasHarness'
import type { WsNode } from '../shared/workspace'

const { sent } = vi.hoisted(() => ({ sent: [] as { t: string; id: string; cols?: number; rows?: number }[] }))
vi.mock('./ws', async (importOriginal) => {
  const real = await importOriginal<typeof import('./ws')>()
  return { ...real, send: (m: { t: string; id: string }) => { sent.push(m) } }
})
// Fallback diperpendek supaya test "tak pernah berukuran" tidak menunggu detik sungguhan.
const { FALLBACK_MS } = vi.hoisted(() => ({ FALLBACK_MS: 60 }))
vi.mock('./terminalSizing', async (importOriginal) => {
  const real = await importOriginal<typeof import('./terminalSizing')>()
  return { ...real, OPEN_SIZE_FALLBACK_MS: FALLBACK_MS }
})

const termNode: WsNode = {
  id: 'term-1', kind: 'terminal', x: 0, y: 0, width: 420, height: 320, cwd: '/', title: 'shell',
}

/** Ukuran host terminal (kelas `nowheel`); 0 = elemen tersembunyi/collapsed. */
let hostSize = 0
const OBSERVER_SETTLE_MS = 120

beforeAll(() => {
  installCanvasDom()
  for (const dim of ['clientWidth', 'clientHeight'] as const) {
    Object.defineProperty(HTMLElement.prototype, dim, {
      configurable: true,
      get(this: HTMLElement) { return this.classList.contains('nowheel') ? hostSize : 0 },
    })
  }
})
afterEach(() => {
  unmountCanvas()
  sent.length = 0
  hostSize = 0
})

const ofType = (t: string) => sent.filter((m) => m.t === t)

describe('TerminalCore', () => {
  it('host terminal ber-kelas nowheel + nodrag, jadi scroll tidak mem-pan canvas', async () => {
    await mountCanvas({ nodes: [termNode], dirs: {} })
    const host = document.querySelector('.react-flow__node-terminal .node-body .nowheel')
    expect(host).not.toBeNull()
    expect(host?.classList.contains('nodrag')).toBe(true)
  })

  it('elemen berukuran: `open` langsung terkirim sekali, resize tak pernah berulang untuk ukuran sama', async () => {
    hostSize = 400
    await mountCanvas({ nodes: [termNode], dirs: {} })

    await waitFor(() => expect(ofType('open')).toHaveLength(1))
    // Biarkan ResizeObserver + rAF menyala (jsdom mengukur grid lain dari 80x24, jadi satu resize sah).
    await new Promise((r) => setTimeout(r, OBSERVER_SETTLE_MS))
    expect(ofType('open')).toHaveLength(1)
    const sizes = ofType('resize').map((m) => `${m.cols}x${m.rows}`)
    expect(new Set(sizes).size).toBe(sizes.length)
    expect(sizes).not.toContain('80x24')
  })

  it('elemen 0x0: `open` ditunda, lalu terkirim lewat fallback batas waktu', async () => {
    hostSize = 0
    await mountCanvas({ nodes: [termNode], dirs: {} })
    expect(ofType('open')).toHaveLength(0)

    await waitFor(() => expect(ofType('open')).toHaveLength(1))
    expect(ofType('open')[0]).toMatchObject({ id: 'term-1', cols: 80, rows: 24 })
  })
})
