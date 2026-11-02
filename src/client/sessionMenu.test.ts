import { describe, expect, it, vi } from 'vitest'
import { buildSessionMenu, type SessionMenuActions } from './sessionMenu'
import type { VscodeMenuItem } from './components/vscode/vscodeMenu'

const actions = (): SessionMenuActions => ({
  onFocusNode: vi.fn(),
  onCloseSession: vi.fn(),
  onReopenSession: vi.fn(),
  onSelectWorkspace: vi.fn(),
  onToggleGroup: vi.fn(),
  onCopyText: vi.fn(),
})

const labels = (items: VscodeMenuItem[]) =>
  items.map((i) => (i.type === 'item' ? i.label : i.type === 'separator' ? '---' : i.label))

const byLabel = (items: VscodeMenuItem[], label: string) => {
  const found = items.find((i) => i.type === 'item' && i.label === label)
  if (!found || found.type !== 'item') throw new Error(`item ${label} tidak ada`)
  return found
}

describe('buildSessionMenu', () => {
  it('sesi: Reveal, Copy Path, End Session dipisah seperti menu VS Code', () => {
    const a = actions()
    const items = buildSessionMenu({ kind: 'session', id: 's1', path: '/w' }, false, a)
    expect(labels(items)).toEqual(['Reveal on Canvas', '---', 'Copy Path', '---', 'End Session'])

    byLabel(items, 'Copy Path').onSelect?.()
    byLabel(items, 'End Session').onSelect?.()
    expect(a.onCopyText).toHaveBeenCalledWith('/w')
    expect(a.onCloseSession).toHaveBeenCalledWith('s1')
  })

  it('Copy Path nonaktif bila sesi tak punya path', () => {
    const items = buildSessionMenu({ kind: 'session', id: 's1' }, false, actions())
    expect(byLabel(items, 'Copy Path').disabled).toBe(true)
  })

  it('Recently closed: Reopen Session nonaktif tanpa handler', () => {
    const a = { ...actions(), onReopenSession: undefined }
    const items = buildSessionMenu({ kind: 'reopen', id: 'r1', path: '/p' }, false, a)
    expect(byLabel(items, 'Reopen Session').disabled).toBe(true)
  })

  it('grup workspace: Switch to Workspace nonaktif bila sudah aktif; label toggle ikut keadaan', () => {
    const a = actions()
    const group = { kind: 'group', key: 'project:p1', projectId: 'p1', isActive: true } as const
    const open = buildSessionMenu(group, true, a)
    expect(byLabel(open, 'Switch to Workspace').disabled).toBe(true)
    byLabel(open, 'Collapse').onSelect?.()
    expect(a.onToggleGroup).toHaveBeenCalledWith('project:p1', true)

    const closed = buildSessionMenu({ ...group, isActive: false }, false, a)
    expect(byLabel(closed, 'Switch to Workspace').disabled).toBe(false)
    expect(labels(closed)).toContain('Expand')
  })

  it('grup non-workspace hanya Collapse/Expand', () => {
    expect(labels(buildSessionMenu({ kind: 'group', key: 'status:idle' }, true, actions()))).toEqual(['Collapse'])
  })
})
