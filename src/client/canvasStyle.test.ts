import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { Edge, Node } from '@xyflow/react'
import {
  ARROW_SIZE, connectionLineStyle, decorateEdges, EDGE_INTERACTION_WIDTH, EDGE_STROKE, EDGE_STROKE_OPACITY_PCT, EDGE_STROKE_SELECTED,
  EDGE_WIDTH, EDGE_WIDTH_EXTRA, IDLE_ARROW_STROKE, miniMapNodeColor, MINIMAP_NODE_NEUTRAL, SELECTED_ARROW_STROKE,
} from './canvasStyle'

const nodes: Node[] = [
  { id: 'a', position: { x: 0, y: 0 }, data: {} },
  { id: 'b', position: { x: 0, y: 0 }, data: {} },
]
const css = readFileSync(fileURLToPath(new URL('./canvas-ui.css', import.meta.url)), 'utf8')
const edge = (selected: boolean): Edge => ({ id: 'e', source: 'a', target: 'b', selected, data: { kind: 'context' } })

describe('decorateEdges — gaya VS Code', () => {
  it('idle: garis 2px berwarna foreground editor, label kecil tanpa bold, tanpa warna mentah', () => {
    const [e] = decorateEdges([edge(false)], nodes)
    expect(EDGE_WIDTH).toBe(2)
    expect(e.style).toEqual({ stroke: EDGE_STROKE, strokeWidth: 2 })
    expect(EDGE_STROKE).toContain('--vscode-editor-foreground')
    expect(e.markerEnd).toMatchObject({ color: 'currentColor', width: ARROW_SIZE, height: ARROW_SIZE, strokeWidth: IDLE_ARROW_STROKE })
    expect(e.labelStyle).not.toHaveProperty('fontWeight')
    expect(JSON.stringify(e)).not.toMatch(/#[0-9a-f]{3,8}/i)
  })

  it('terpilih: focusBorder 3px, panah memakai strokeWidth penanda CSS', () => {
    const [e] = decorateEdges([edge(true)], nodes)
    expect(e.style).toEqual({ stroke: EDGE_STROKE_SELECTED, strokeWidth: 3 })
    expect(e.markerEnd).toMatchObject({ color: 'currentColor', strokeWidth: SELECTED_ARROW_STROKE })
    expect(css).toContain(`[id*='strokeWidth=${SELECTED_ARROW_STROKE}']`)
  })

  it('ukuran panah 12-14px dan area klik lebar', () => {
    const [e] = decorateEdges([edge(false)], nodes)
    expect(ARROW_SIZE).toBeGreaterThanOrEqual(12)
    expect(ARROW_SIZE).toBeLessThanOrEqual(14)
    expect(e.interactionWidth).toBe(EDGE_INTERACTION_WIDTH)
    expect(EDGE_INTERACTION_WIDTH).toBeGreaterThanOrEqual(20)
  })

  it('id marker panah idle berbeda dari terpilih (selector CSS hanya cocok yang terpilih)', () => {
    const [idle] = decorateEdges([edge(false)], nodes)
    const [sel] = decorateEdges([edge(true)], nodes)
    expect(IDLE_ARROW_STROKE).not.toBe(SELECTED_ARROW_STROKE)
    // React Flow menyusun id marker dari semua propertinya, jadi properti beda = id beda.
    expect(JSON.stringify(idle.markerEnd)).not.toBe(JSON.stringify(sel.markerEnd))
  })

  it('canvas-ui.css selaras: warna marker idle = EDGE_STROKE (ikut --edge-color), hover menambah tebal', () => {
    const marker = `var(--edge-color, color-mix(in srgb, var(--vscode-editor-foreground, var(--muted)) ${EDGE_STROKE_OPACITY_PCT}%, transparent))`
    expect(EDGE_STROKE).toBe(marker)
    expect(css).toMatch(/\.react-flow__marker\s*\{[^}]*color:\s*var\(--edge-color,/)
    expect(css).toMatch(new RegExp(`\\.react-flow__edge:hover\\s*\\{[^}]*--edge-hover-extra:\\s*${EDGE_WIDTH_EXTRA}px`))
    expect(EDGE_WIDTH_EXTRA).toBeGreaterThan(0)
  })

  it('kabel yang sedang ditarik sama dengan kabel idle', () => {
    expect(connectionLineStyle(3)).toEqual(decorateEdges([edge(false)], nodes, 3)[0].style)
    expect(connectionLineStyle()).toEqual(decorateEdges([edge(false)], nodes)[0].style)
  })

  it('tebal pilihan dipakai; terpilih tetap lebih tebal dan tetap focusBorder', () => {
    for (const w of [1, 1.5, 4]) {
      expect(decorateEdges([edge(false)], nodes, w)[0].style).toEqual({ stroke: EDGE_STROKE, strokeWidth: w })
      expect(decorateEdges([edge(true)], nodes, w)[0].style).toEqual({ stroke: EDGE_STROKE_SELECTED, strokeWidth: w + EDGE_WIDTH_EXTRA })
    }
  })
})

describe('miniMapNodeColor — minimap netral', () => {
  const n = (id: string, type: string, color?: string): Node => ({ id, type, position: { x: 0, y: 0 }, data: { color } })

  it('terminal, files, editor dan warna pilihan node semuanya netral', () => {
    for (const node of [n('t', 'terminal'), n('f', 'files', '#ff0000'), n('e', 'editor', 'rgb(1,2,3)')]) {
      expect(miniMapNodeColor(node, {})).toBe(MINIMAP_NODE_NEUTRAL)
    }
    expect(MINIMAP_NODE_NEUTRAL).toContain('--vscode-editorLineNumber-foreground')
  })

  it('hanya status agent yang berwarna, lewat token status (bukan hex)', () => {
    expect(miniMapNodeColor(n('a', 'agent'), { a: 'working' })).toBe('var(--state-working)')
    expect(miniMapNodeColor(n('a', 'agent'), { a: 'waiting' })).toBe('var(--state-warning)')
    expect(miniMapNodeColor(n('a', 'agent'), { a: 'blocked' })).toBe('var(--state-attention)')
    expect(miniMapNodeColor(n('a', 'agent'), { a: 'done' })).toBe(MINIMAP_NODE_NEUTRAL)
  })
})
