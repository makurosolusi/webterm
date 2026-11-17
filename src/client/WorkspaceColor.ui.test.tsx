/** @vitest-environment jsdom */
// Workspace color in the UI: tab identity marker, the Color… dialog (radio swatches, arrows, shades,
// Random) and the optimistic change with rollback on a failed save.
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import './vscode/test-setup'
import WorkspaceBar from './WorkspaceBar'
import { WorkspaceColorDialog } from './WorkspaceColorPicker'
import { applyColor, useSetWorkspaceColor, type ColorTarget } from './workspaceColor.sync'
import * as api from './api'
import { dispatchBroadcast } from './ws.listeners'
import { useWorkspaceColorPush } from './workspaceColor.sync'
import { DEFAULT_VIEWPORT, type Workspace } from '../shared/workspace'

const ws = (id: string, name: string, color?: string, colorShade?: string): Workspace =>
  ({ id, name, cwd: `/${id}`, color, colorShade, viewport: DEFAULT_VIEWPORT, nodes: [], bridges: [], updatedAt: 0 }) // test-only

beforeEach(() => { vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ managed: false })))) })
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('tab identity marker', () => {
  it('sets each tab accent to its workspace color token and opens the picker from the tab menu', () => {
    const onSetWorkspaceColor = vi.fn()
    render(
      <WorkspaceBar
        workspaces={[ws('w1', 'laya-api', 'teal', 'vivid'), ws('w2', 'noc', 'pink')]} activeId="w1" liveActiveNodes={[]} statuses={{}}
        onSelect={vi.fn()} onNewWorkspace={vi.fn()} onRenameWorkspace={vi.fn()} onDeleteWorkspace={vi.fn()}
        onSetWorkspaceColor={onSetWorkspaceColor}
      />,
    )
    const accents = [...document.querySelectorAll<HTMLElement>('.vscode-editor-tab[data-accent]')].map((el) => el.style.getPropertyValue('--tab-accent'))
    expect(accents).toEqual(['var(--ws-teal-vivid)', 'var(--ws-pink-default)'])
    fireEvent.contextMenu(screen.getByRole('tab', { name: /noc/ }), { clientX: 10, clientY: 10 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Color…' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Blue' }))
    expect(onSetWorkspaceColor).toHaveBeenCalledWith('w2', { color: 'blue' })
  })
})

describe('WorkspaceColorDialog', () => {
  const mount = (onChange = vi.fn(), color = 'green', shade = 'default') => {
    render(<WorkspaceColorDialog open onOpenChange={vi.fn()} workspaceName="noc" color={color} colorShade={shade} onChange={onChange} />)
    return onChange
  }
  it('offers 12 named colors and 3 shades as radios with the current ones checked', () => {
    mount()
    const colors = screen.getByRole('radiogroup', { name: 'Workspace color' })
    expect(colors.querySelectorAll('[role=radio]').length).toBe(12)
    expect(screen.getByRole('radio', { name: 'Green' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('radio', { name: 'Red' }).getAttribute('aria-checked')).toBe('false')
    expect(screen.getByRole('radiogroup', { name: 'Shade' }).querySelectorAll('[role=radio]').length).toBe(3)
    expect(screen.getByRole('radio', { name: 'Default' }).getAttribute('aria-checked')).toBe('true')
  })
  it('moves and selects with the arrow keys (wrapping), and picks a shade', () => {
    const onChange = mount(vi.fn(), 'slate')
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Slate' }), { key: 'ArrowRight' })
    expect(onChange).toHaveBeenLastCalledWith({ color: 'red' }) // wraps past the last hue
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Red' }), { key: 'ArrowLeft' })
    expect(onChange).toHaveBeenLastCalledWith({ color: 'slate' })
    fireEvent.click(screen.getByRole('radio', { name: 'Vivid' }))
    expect(onChange).toHaveBeenLastCalledWith({ colorShade: 'vivid' })
  })
  it('Random asks for a random color', () => {
    const onChange = mount()
    fireEvent.click(screen.getByRole('button', { name: 'Random' }))
    expect(onChange).toHaveBeenCalledWith({ random: true })
  })
})

function target(initial: Workspace[]) {
  let list = initial
  const t: ColorTarget = {
    activeWsRef: { current: initial[0] },
    setActiveWs: vi.fn(),
    setWorkspaces: ((fn: (p: Workspace[]) => Workspace[]) => { list = fn(list) }) as ColorTarget['setWorkspaces'],
  }
  return { t, get: () => list }
}

describe('optimistic color change', () => {
  it('shows the new color at once and settles on the server answer', async () => {
    const { t, get } = target([ws('w1', 'a', 'red', 'soft')])
    vi.spyOn(api, 'setWorkspaceColor').mockResolvedValue({ color: 'blue', colorShade: 'soft' })
    const { result } = renderHook(() => useSetWorkspaceColor(t, get()))
    await act(async () => { await result.current('w1', { color: 'blue' }) })
    expect(get()[0].color).toBe('blue')
    expect(t.activeWsRef.current?.color).toBe('blue')
  })
  it('rolls back and rethrows with the workspace named when the save fails', async () => {
    const { t, get } = target([ws('w1', 'laya-api', 'red', 'soft')])
    vi.spyOn(api, 'setWorkspaceColor').mockRejectedValue(new Error('PUT -> 500'))
    const { result } = renderHook(() => useSetWorkspaceColor(t, get()))
    await expect(result.current('w1', { color: 'blue' })).rejects.toThrow(/laya-api.*500/)
    expect(get()[0].color).toBe('red')
    expect(get()[0].colorShade).toBe('soft')
    expect(t.activeWsRef.current?.color).toBe('red')
  })
  it('follows a color pushed by the server (another window or Central)', async () => {
    const { t, get } = target([ws('w1', 'a', 'red'), ws('w2', 'b', 'green')])
    renderHook(() => useWorkspaceColorPush(t))
    act(() => { dispatchBroadcast({ t: 'workspaceColor', workspaceId: 'w2', color: 'violet', shade: 'vivid' }) })
    await waitFor(() => expect(get()[1].color).toBe('violet'))
    expect(get()[1].colorShade).toBe('vivid')
    expect(get()[0].color).toBe('red')
  })
  it('applyColor leaves the list untouched for an unknown id', () => {
    const { t, get } = target([ws('w1', 'a', 'red')])
    applyColor(t, 'nope', 'blue', 'soft')
    expect(get()[0].color).toBe('red')
  })
})
