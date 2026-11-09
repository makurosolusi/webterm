/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultTabLayout } from '../shared/tabLayout.schema'
import { connectTabLayout, getTabLayout } from './tabLayout.store'
import { GROUP_ID, UNGROUP_ID, focusInsideNode, layersCommands } from './layers.commands'

const run = (id: string, selected: string[]) => layersCommands(() => selected).find((c) => c.id === id)?.run?.()

beforeEach(() => {
  const l = defaultTabLayout()
  connectTabLayout({ ...l, tabs: { ...l.tabs, order: ['a', 'b', 'c'] } }, null)
})
afterEach(() => { document.body.innerHTML = '' })

describe('layers commands', () => {
  it('Group Selection groups the selected ids; Ungroup removes their group', () => {
    run(GROUP_ID, ['a', 'c'])
    expect(getTabLayout().tabs.groups.map((g) => g.ids)).toEqual([['a', 'c']])
    run(UNGROUP_ID, ['c'])
    expect(getTabLayout().tabs.groups).toEqual([])
  })

  it('nothing selected = no group', () => {
    run(GROUP_ID, [])
    expect(getTabLayout().tabs.groups).toEqual([])
  })

  it('is a no-op while focus is inside a node (terminal, editor, browser)', () => {
    document.body.innerHTML = '<div class="react-flow__node" data-id="a" tabindex="-1"><textarea></textarea></div>'
    const inner = document.querySelector('textarea')!
    inner.focus()
    expect(focusInsideNode()).toBe(true)
    run(GROUP_ID, ['a', 'b'])
    expect(getTabLayout().tabs.groups).toEqual([])
    // Focus on the node wrapper itself (after a reveal) is still the canvas.
    document.querySelector<HTMLElement>('.react-flow__node')!.focus()
    expect(focusInsideNode()).toBe(false)
    run(GROUP_ID, ['a', 'b'])
    expect(getTabLayout().tabs.groups).toHaveLength(1)
  })
})
