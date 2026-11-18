/** @vitest-environment jsdom */
// Shape of the skill node (docs/decisions/skill-node-shape.md): round token collapsed, pill-radius card expanded,
// label under the circle with a tooltip trigger, status as icon + text, round selection ring, handle on the rim,
// old 260x44 boards load as tokens, mini-map accent, reduced motion.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ReactFlow, ReactFlowProvider, useNodesState, type Node } from '@xyflow/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import './vscode/test-setup'
import type { CanvasSkillsLoad } from './skillNode.api'
import { SKILL_NODE_SIZE, SKILL_OUT } from '../shared/skillPorts'
import { toFlow } from './store'
import { miniMapNodeColor, MINIMAP_SKILL_ACCENT } from './canvasStyle'

const lib = vi.hoisted(() => ({ load: { status: 'loading' } as unknown, reload: vi.fn() }))
vi.mock('./skillNode.api', () => ({ useCanvasSkills: () => ({ ...(lib.load as object), reload: lib.reload }) }))

import SkillNode from './SkillNode'

beforeAll(() => { globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver })
afterEach(() => { cleanup(); vi.clearAllMocks() })

function Canvas({ data }: { data: Record<string, unknown> }) {
  const [nodes, , onNodesChange] = useNodesState<Node>([{ id: 's1', type: 'skill', position: { x: 0, y: 0 }, ...SKILL_NODE_SIZE, data }])
  return <div style={{ width: 800, height: 600 }}><ReactFlowProvider><ReactFlow nodes={nodes} onNodesChange={onNodesChange} nodeTypes={{ skill: SkillNode }} /></ReactFlowProvider></div>
}
const ready = (over: Partial<{ version: string; enabled: boolean }> = {}): CanvasSkillsLoad => ({ status: 'ready', skills: [{ name: 'webterm-release', version: '2', enabled: true, description: 'Ship.', ...over }] })
const show = (load: CanvasSkillsLoad, data: Record<string, unknown> = { skill: 'webterm-release', seenVersion: '2' }) => { lib.load = load; render(<Canvas data={data} />) }

const css = readFileSync(resolve(process.cwd(), 'src/client/skillNode.shape.css'), 'utf8')

describe('skill node shape', () => {
  it('collapsed = a round token, not a card; expanded = a card with the same glyph as avatar', async () => {
    show(ready())
    await waitFor(() => expect(document.querySelector('[data-shape="token"]')).toBeTruthy())
    expect(document.querySelector('.term-node')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Expand' }))
    expect(document.querySelector('[data-shape="token"]')).toBeNull()
    expect(document.querySelector('.skill-card .skill-card__avatar .codicon-book')).toBeTruthy()
    fireEvent.click(document.querySelector('[data-title="Collapse"]')!)
    await waitFor(() => expect(document.querySelector('[data-shape="token"]')).toBeTruthy())
  })

  it('double-click on the token expands it', async () => {
    show(ready())
    fireEvent.doubleClick(await waitFor(() => document.querySelector('.skill-token__ring')!))
    expect(document.querySelector('.skill-card')).toBeTruthy()
  })

  it('the title is the label under the circle, a tooltip trigger; the slug appears when it differs', async () => {
    show(ready(), { skill: 'webterm-release', title: 'A very long skill title that cannot fit on two lines of a small label' })
    const title = await waitFor(() => document.querySelector('.skill-token__label .skill-token__title')!)
    expect(title.textContent).toContain('A very long skill title')
    expect(title.getAttribute('tabindex')).toBe('0')
    expect(document.querySelector('.skill-token__slug')?.textContent).toBe('webterm-release')
    expect(css).toMatch(/-webkit-line-clamp: 2/)
  })

  it('not attached = dashed ring; the version sits on the rim', async () => {
    show(ready())
    await waitFor(() => expect(document.querySelector('.skill-token--detached')).toBeTruthy())
    expect(document.querySelector('.skill-token__version')?.textContent).toBe('v2')
    expect(css).toMatch(/skill-token--detached \.skill-token__ring[^{]*\{ border-style: dashed/)
  })

  it('status is icon + text: disabled and unavailable keep their badge, the rim mark carries an icon', async () => {
    show(ready({ enabled: false }))
    expect((await screen.findByText('Disabled')).querySelector('.codicon-circle-slash')).toBeTruthy()
    expect(document.querySelector('.skill-token__mark--disabled .codicon-circle-slash')).toBeTruthy()
    cleanup()
    show({ status: 'ready', skills: [] })
    expect((await screen.findByText('Unavailable')).querySelector('.codicon-warning')).toBeTruthy()
    expect(document.querySelector('.skill-token__mark--unavailable .codicon-warning')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Remove skill node' })).toBeTruthy()
  })

  it('"Updated" shows a pulse dot as well as the dismiss button', async () => {
    show(ready({ version: '3' }))
    expect(await screen.findByRole('button', { name: /active version changed/i })).toBeTruthy()
    expect(document.querySelector('.skill-token__pulse')).toBeTruthy()
  })

  it('aria-label is unchanged and the skill-out handle stays on top with its id', async () => {
    show(ready())
    expect((await screen.findByRole('group', { name: /^Skill webterm-release/ })).getAttribute('aria-label')).toBe('Skill webterm-release, not attached, Active')
    const h = document.querySelector(`[data-handleid="${SKILL_OUT}"]`)!
    expect(h.classList.contains('react-flow__handle-top')).toBe(true)
    expect(h.classList.contains('source')).toBe(true)
  })

  it('selection is drawn on the circle: no square outline or shadow on the node box', () => {
    expect(css).toMatch(/\.react-flow__node-skill \{[^}]*background: transparent[^}]*box-shadow: none[^}]*outline: none/)
    expect(css).toMatch(/\.react-flow__node-skill\.selected \.skill-token__ring \{ box-shadow:/)
    expect(css).toMatch(/\.skill-token__ring \{[^}]*border-radius: 50%/)
  })

  it('motion respects prefers-reduced-motion', () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{[^}]*animation: none/)
  })

  it('a board saved with the old 260x44 collapsed card loads as a token (position kept); an expanded one keeps its size', () => {
    const old = { id: 's', kind: 'skill' as const, x: 40, y: 50, width: 260, height: 44, skill: 'a', collapsed: true }
    expect(toFlow(old)).toMatchObject({ position: { x: 40, y: 50 }, ...SKILL_NODE_SIZE })
    expect(toFlow({ ...old, collapsed: undefined })).toMatchObject(SKILL_NODE_SIZE)
    expect(toFlow({ ...old, collapsed: false, width: 300, height: 150 })).toMatchObject({ width: 300, height: 150 })
    expect(toFlow({ ...old, collapsed: false, width: undefined, height: undefined })).toMatchObject({ width: 260, height: 124 })
  })

  it('mini-map: a skill has its own accent colour, other nodes keep theirs', () => {
    const n = (type: string) => ({ id: 'x', type, position: { x: 0, y: 0 }, data: {} }) as Node
    expect(miniMapNodeColor(n('skill'), {})).toBe(MINIMAP_SKILL_ACCENT)
    expect(miniMapNodeColor(n('terminal'), {})).not.toBe(MINIMAP_SKILL_ACCENT)
  })
})
