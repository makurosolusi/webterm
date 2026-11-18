/** @vitest-environment jsdom */
// Tab dot: workspace colour fill, status only as a corner badge, combined aria-label.
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkspaceTabDot, workspaceTabAria, workspaceTabFields } from './WorkspaceTabDot'
import type { SessionGroup, SessionRowVM } from './sessionList'
import { sessionStatusView } from './sessionStatus.model'

afterEach(cleanup)

// test-only fixtures
const STATUS = { working: 'working', attention: 'blocked', done: 'done', unknown: undefined } as const
const row = (id: string, s: keyof typeof STATUS): SessionRowVM =>
  ({ id, label: id, title: id, kind: 'agent', view: sessionStatusView({ status: STATUS[s] }), projectId: 'p', projectName: 'laya-api' })
const group = (isActive: boolean, sessions: SessionRowVM[]): SessionGroup => ({ projectId: 'p', projectName: 'laya-api', isActive, sessions })

const mount = (g: SessionGroup, color = 'pink', shade?: string) => {
  const { container } = render(<WorkspaceTabDot group={g} color={color} shade={shade} />)
  return container.querySelector<HTMLElement>('.ws-dot')!
}

describe('WorkspaceTabDot', () => {
  it('fills with the workspace token whatever the status', () => {
    expect(mount(group(true, [row('a', 'attention')]), 'teal', 'vivid').style.getPropertyValue('--ws-dot')).toBe('var(--ws-teal-vivid)')
    cleanup()
    expect(mount(group(false, []), 'pink').style.getPropertyValue('--ws-dot')).toBe('var(--ws-pink-default)')
  })

  it('shows a badge only for working or attention', () => {
    expect(mount(group(true, [row('a', 'working')])).querySelector('.ws-dot__badge--working')).not.toBeNull()
    cleanup()
    expect(mount(group(true, [row('a', 'attention'), row('b', 'working')])).querySelector('.ws-dot__badge--attention')).not.toBeNull()
    for (const g of [group(true, [row('a', 'done')]), group(true, []), group(false, [row('a', 'working')])]) {
      cleanup()
      expect(mount(g).querySelector('.ws-dot__badge')).toBeNull()
    }
  })

  it('names workspace, color and live agent counts in one aria-label', () => {
    expect(workspaceTabAria(group(true, [row('a', 'working'), row('b', 'working')]), 'pink', 'default')).toBe('Workspace laya-api, color pink, 2 agents running')
    expect(workspaceTabAria(group(true, [row('a', 'attention')]), 'teal', 'vivid')).toBe('Workspace laya-api, color teal vivid, 1 agent waiting for you')
    expect(mount(group(true, [row('a', 'working')])).getAttribute('aria-label')).toBe('Workspace laya-api, color pink, 1 agent running')
  })

  it('puts the color name in the tab tooltip', () => {
    expect(workspaceTabFields(group(true, []), { color: 'blue', colorShade: 'soft' }).tooltip).toContain('Color: blue soft')
    expect(workspaceTabFields(group(true, []), undefined).tooltip).toContain('Color: none')
  })
})
