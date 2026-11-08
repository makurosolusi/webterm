import { describe, it, expect } from 'vitest'
import { EDITOR_SIZE, openEditorFor, planFileOpen } from './fileOpen'

const files = { id: 'f1', type: 'files', data: {} }
const editor = (id: string, filePath: string) => ({ id, type: 'editor', data: { filePath } })

describe('openEditorFor', () => {
  it('finds the editor node holding that path', () => {
    const nodes = [files, editor('e1', '/w/a.ts'), editor('e2', '/w/b.ts')]
    expect(openEditorFor(nodes, '/w/b.ts')).toBe('e2')
  })

  it('is null when no editor holds the path', () => {
    expect(openEditorFor([files, editor('e1', '/w/a.ts')], '/w/zz.ts')).toBeNull()
  })

  it('ignores a non-editor node that happens to carry a filePath', () => {
    const nodes = [{ id: 't1', type: 'terminal', data: { filePath: '/w/a.ts' } }]
    expect(openEditorFor(nodes, '/w/a.ts')).toBeNull()
  })
})

describe('planFileOpen', () => {
  it('creates a node + cable for a file that is not open yet', () => {
    const plan = planFileOpen([files], [], 'f1', '/w/a.ts', 'new1')
    expect(plan.focus).toBe(false)
    expect(plan.nodeId).toBe('new1')
    expect(plan.edge).toEqual({ id: 'bridge-f1-new1', source: 'f1', target: 'new1', kind: 'file' })
  })

  it('focuses the open editor instead of minting a second one', () => {
    const nodes = [files, editor('e1', '/w/a.ts')]
    const edges = [{ source: 'f1', target: 'e1' }]
    const plan = planFileOpen(nodes, edges, 'f1', '/w/a.ts', 'new1')
    expect(plan).toEqual({ focus: true, swap: false, nodeId: 'e1', edge: null })
  })

  it('re-attaches the cable when the node is still open but the cable was deleted', () => {
    const plan = planFileOpen([files, editor('e1', '/w/a.ts')], [], 'f1', '/w/a.ts', 'new1')
    expect(plan.focus).toBe(true)
    expect(plan.nodeId).toBe('e1')
    expect(plan.edge).toEqual({ id: 'bridge-f1-e1', source: 'f1', target: 'e1', kind: 'file' })
  })

  it('does not duplicate a cable drawn the other way round', () => {
    const plan = planFileOpen([files, editor('e1', '/w/a.ts')], [{ source: 'e1', target: 'f1' }], 'f1', '/w/a.ts', 'n')
    expect(plan.edge).toBeNull()
  })

  it('counts each files node separately: a second one gets its own cable to the same editor', () => {
    const nodes = [files, { id: 'f2', type: 'files', data: {} }, editor('e1', '/w/a.ts')]
    const plan = planFileOpen(nodes, [{ source: 'f1', target: 'e1' }], 'f2', '/w/a.ts', 'new1')
    expect(plan.focus).toBe(true)
    expect(plan.edge).toEqual({ id: 'bridge-f2-e1', source: 'f2', target: 'e1', kind: 'file' })
  })

  it('carries nodeterm EDITOR_SIZE so the editor is not born unreadably small', () => {
    expect(EDITOR_SIZE).toEqual({ width: 660, height: 460 })
  })
})

describe('planFileOpen preview', () => {
  const pv = (id: string, filePath: string) => ({ id, type: 'editor', data: { filePath, preview: true } })

  it('swaps the preview editor cabled from this files node instead of minting one', () => {
    const plan = planFileOpen([files, pv('e1', '/w/a.ts')], [{ source: 'f1', target: 'e1' }], 'f1', '/w/b.ts', 'new1', true)
    expect(plan).toEqual({ focus: false, swap: true, nodeId: 'e1', edge: null })
  })

  it('never swaps for preview:false, nor a pinned editor', () => {
    expect(planFileOpen([files, pv('e1', '/w/a.ts')], [{ source: 'f1', target: 'e1' }], 'f1', '/w/b.ts', 'n', false).nodeId).toBe('n')
    expect(planFileOpen([files, editor('e1', '/w/a.ts')], [{ source: 'f1', target: 'e1' }], 'f1', '/w/b.ts', 'n', true).nodeId).toBe('n')
  })

  it('a file already open wins over the swap', () => {
    const nodes = [files, pv('e1', '/w/a.ts'), editor('e2', '/w/b.ts')]
    const plan = planFileOpen(nodes, [{ source: 'f1', target: 'e1' }], 'f1', '/w/b.ts', 'n', true)
    expect(plan).toMatchObject({ focus: true, swap: false, nodeId: 'e2' })
  })
})
