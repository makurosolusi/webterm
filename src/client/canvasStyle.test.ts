import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { Edge, Node } from '@xyflow/react'
import {
  decorateEdges, EDGE_STROKE, EDGE_STROKE_SELECTED, miniMapNodeColor, MINIMAP_NODE_NEUTRAL, SELECTED_ARROW_STROKE,
} from './canvasStyle'

const nodes: Node[] = [
  { id: 'a', position: { x: 0, y: 0 }, data: {} },
  { id: 'b', position: { x: 0, y: 0 }, data: {} },
]
const edge = (selected: boolean): Edge => ({ id: 'e', source: 'a', target: 'b', selected, data: { kind: 'context' } })

describe('decorateEdges — gaya VS Code', () => {
  it('idle: garis netral 1px, label kecil tanpa bold, tanpa warna mentah', () => {
    const [e] = decorateEdges([edge(false)], nodes)
    expect(e.style).toEqual({ stroke: EDGE_STROKE, strokeWidth: 1 })
    expect(e.labelStyle).not.toHaveProperty('fontWeight')
    expect(JSON.stringify(e)).not.toMatch(/#[0-9a-f]{3,8}/i)
  })

  it('terpilih: focusBorder 1.5px, panah memakai strokeWidth penanda CSS', () => {
    const [e] = decorateEdges([edge(true)], nodes)
    expect(e.style).toEqual({ stroke: EDGE_STROKE_SELECTED, strokeWidth: 1.5 })
    expect(e.markerEnd).toMatchObject({ color: 'currentColor', strokeWidth: SELECTED_ARROW_STROKE })
    const css = readFileSync(fileURLToPath(new URL('./canvas-ui.css', import.meta.url)), 'utf8')
    expect(css).toContain(`[id*='strokeWidth=${SELECTED_ARROW_STROKE}']`)
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
