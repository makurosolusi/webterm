/**
 * @vitest-environment jsdom
 */
// Drop path dari file manager ke node terminal, di canvas sungguhan (pola terminalNodeMenu.test.tsx).
import { createEvent, fireEvent } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/xterm'
import { installCanvasDom, mountCanvas, unmountCanvas } from './canvasHarness'
import { PATH_DROP_MIME } from './terminalDrop'
import type { WsNode } from '../shared/workspace'

const termNode: WsNode = {
  id: 'term-1', kind: 'terminal', x: 0, y: 0, width: 420, height: 320, cwd: '/', title: 'shell',
}

const termBody = (): HTMLElement => {
  const el = document.querySelector('.react-flow__node-terminal .node-body')
  if (!el) throw new Error('badan node terminal tidak dirender')
  return el as HTMLElement
}

const dataTransfer = (data: Record<string, string>) => ({
  types: Object.keys(data),
  getData: (t: string) => data[t] ?? '',
  dropEffect: 'none',
})

/** Event drag `cancelable` dengan dataTransfer palsu (jsdom tak punya DataTransfer). */
function drag(type: 'dragOver' | 'drop', data: Record<string, string>) {
  const dt = dataTransfer(data)
  const ev = createEvent[type](termBody(), { dataTransfer: dt })
  fireEvent(termBody(), ev)
  return { ev, dt }
}

beforeAll(installCanvasDom)
afterEach(() => {
  unmountCanvas()
  vi.restoreAllMocks()
})

describe('drop path ke node terminal', () => {
  it('drop path memanggil term.paste dengan path + spasi, tanpa newline', async () => {
    const paste = vi.spyOn(Terminal.prototype, 'paste').mockImplementation(() => {})
    await mountCanvas({ nodes: [termNode], dirs: {} })

    const { ev } = drag('drop', { [PATH_DROP_MIME]: "'/a/b c.txt'" })

    expect(ev.defaultPrevented).toBe(true)
    expect(paste).toHaveBeenCalledTimes(1)
    expect(paste).toHaveBeenCalledWith("'/a/b c.txt' ")
  })

  it('dragover path di-preventDefault dengan dropEffect copy', async () => {
    await mountCanvas({ nodes: [termNode], dirs: {} })
    const { ev, dt } = drag('dragOver', { [PATH_DROP_MIME]: "'/x'" })
    expect(ev.defaultPrevented).toBe(true)
    expect(dt.dropEffect).toBe('copy')
  })

  it('drag tanpa MIME kita (text/plain biasa) tidak di-preventDefault dan tidak di-paste', async () => {
    const paste = vi.spyOn(Terminal.prototype, 'paste').mockImplementation(() => {})
    await mountCanvas({ nodes: [termNode], dirs: {} })

    expect(drag('dragOver', { 'text/plain': 'x' }).ev.defaultPrevented).toBe(false)
    expect(drag('drop', { 'text/plain': 'rm -rf /' }).ev.defaultPrevented).toBe(false)
    expect(paste).not.toHaveBeenCalled()
  })
})
