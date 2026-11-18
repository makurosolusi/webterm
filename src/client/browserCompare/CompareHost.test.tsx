/** @vitest-environment jsdom */
// Entry point: the split menu row, the pane picker and the host that mounts the overlay inside the node's page area.
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { splitMenuItems } from '../browserSplit/BrowserSplitMenu'
import type { SplitControls } from '../browserSplit/useBrowserSplit'
import { listPanes } from './capture'
import { CompareHost } from './CompareHost'
import { ComparePicker } from './ComparePicker'
import { makePixels } from './diff'

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => ({
    getImageData: (_x: number, _y: number, w: number, h: number) => { const p = makePixels(w, h); p.data.fill(200); return p },
    createImageData: (w: number, h: number) => makePixels(w, h), putImageData: vi.fn(),
  })) as never)
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const controls = (shown: string[]): SplitControls => ({
  layout: null, shown, focusId: shown[0] ?? null, stage: { w: 800, h: 600 },
  canSplitAt: () => ({ ok: true }),
} as unknown as SplitControls)

describe('split menu entry', () => {
  it('has a "Compare panes…" row only when a handler is given', () => {
    expect(splitMenuItems(controls(['a', 'b'])).some((i) => i.type === 'item' && i.id === 'compare')).toBe(false)
    const row = splitMenuItems(controls(['a', 'b']), () => undefined).find((i) => i.type === 'item' && i.id === 'compare')
    expect(row).toMatchObject({ label: 'Compare panes…', disabled: false })
  })
  it('is disabled with a reason below two panes, and runs the handler otherwise', () => {
    const run = vi.fn()
    expect(splitMenuItems(controls(['a']), run).find((i) => i.type === 'item' && i.id === 'compare')).toMatchObject({ disabled: true, title: 'Split the view to compare panes' })
    const ok = splitMenuItems(controls(['a', 'b']), run).find((i) => i.type === 'item' && i.id === 'compare')
    if (ok?.type === 'item') ok.onSelect?.()
    expect(run).toHaveBeenCalledTimes(1)
  })
})

describe('ComparePicker', () => {
  const panes = [{ tabId: 't1', label: 'Home' }, { tabId: 't2', label: 'Pricing' }, { tabId: 't3', label: 'Docs' }]
  it('labels both selects and defaults to the first two panes', () => {
    const onConfirm = vi.fn()
    render(<ComparePicker panes={panes} onConfirm={onConfirm} onCancel={vi.fn()} />)
    expect(screen.getByRole('combobox', { name: 'Left/Base' }).textContent).toBe('Home')
    expect(screen.getByRole('combobox', { name: 'Right/Compare' }).textContent).toBe('Pricing')
    fireEvent.click(screen.getByRole('button', { name: 'Compare' }))
    expect(onConfirm).toHaveBeenCalledWith('t1', 't2')
  })
  it('Cancel leaves without choosing', () => {
    const onConfirm = vi.fn(), onCancel = vi.fn()
    render(<ComparePicker panes={panes} onConfirm={onConfirm} onCancel={onCancel} />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalled()
    expect(onConfirm).not.toHaveBeenCalled()
  })
})

function nodeWith(titles: string[]): HTMLElement {
  const node = document.createElement('div'); node.className = 'browser-node'
  const body = document.createElement('div'); body.className = 'browser-body'
  node.appendChild(body)
  titles.forEach((t, i) => {
    const g = document.createElement('div'); g.setAttribute('data-pane-tab', `t${i + 1}`); g.setAttribute('aria-label', `Pane: ${t}`)
    const c = document.createElement('canvas'); c.width = 4; c.height = 4; g.appendChild(c); body.appendChild(g)
  })
  const btn = document.createElement('button'); node.appendChild(btn)
  document.body.appendChild(node)
  return node
}

describe('CompareHost', () => {
  it('lists the panes on screen with their titles', () => {
    expect(listPanes(nodeWith(['Home', 'Pricing']))).toEqual([{ tabId: 't1', label: 'Home' }, { tabId: 't2', label: 'Pricing' }])
  })

  it('renders nothing below two panes', () => {
    const node = nodeWith(['Home'])
    const { container } = render(<CompareHost anchor={node.querySelector('button')} onWake={vi.fn()} onClose={vi.fn()} />)
    expect(container.innerHTML).toBe('')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('picks panes, then mounts the overlay inside the node page area (not on the screen)', () => {
    const node = nodeWith(['Home', 'Pricing'])
    render(<TooltipProvider><CompareHost anchor={node.querySelector('button')} onWake={vi.fn()} onClose={vi.fn()} /></TooltipProvider>)
    fireEvent.click(screen.getByRole('button', { name: 'Compare' }))
    const overlay = within(node.querySelector('.browser-body') as HTMLElement).getByRole('dialog', { name: 'Compare panes' })
    expect(overlay).toBeTruthy()
  })
})
