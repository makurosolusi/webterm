/** @vitest-environment jsdom */
// Mutate slot driven directly with a fake ctx (fsClient mocked): clipboard Cut/Copy/Paste with name
// collisions and across nodes, cut dimming, Undo (Cmd+Z and toast) for rename/move/copy/trash, and
// the ⌘⌫ / ⌥⌘⌫ / ⇧Delete delete keys with their confirmation.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import './vscode/test-setup'
import type { FileMeta } from '../shared/fsContract'

const fs = vi.hoisted(() => ({ remove: vi.fn(), restore: vi.fn(), rename: vi.fn(), copy: vi.fn() }))
vi.mock('./fsClient', async () => {
  const { capsWith } = await import('./filesCaps.fixture')
  return { ...fs, capabilities: async () => capsWith({ mutate: true }), resetCapabilitiesCache: vi.fn() }
})

import { mutateSlot } from './filesSlot.mutate'
import { clearClip, getClip } from './filesSlot.clipboard'
import { UNDO_LIMIT, popUndo, pushUndo } from './filesUndo'
import type { FilesSlotCtx, InputRequest } from './filesSlots'

const ok = <T extends object>(extra?: T) => Promise.resolve({ ok: true, ...extra })
const settle = () => act(async () => {})
const meta = (name: string, dir = false): FileMeta => ({ name, dir, ignored: false })

function ctxFor(nodeId: string, dir: string, entries: FileMeta[], selection: string[]): FilesSlotCtx {
  return {
    cwd: dir, dir, entries, selection, nodeId, expanded: new Set(), toggle: vi.fn(), collapseAll: vi.fn(),
    startRenameAt: vi.fn(), refresh: vi.fn(), startInput: vi.fn(), open: vi.fn(), notify: vi.fn(() => ''), dismiss: vi.fn(),
  }
}
function Host({ ctx }: { ctx: FilesSlotCtx }) {
  mutateSlot.useSlot!(ctx)
  return <>{mutateSlot.overlay!(ctx)}</>
}
async function mount(...ctxs: FilesSlotCtx[]) {
  const r = render(<>{ctxs.map((c) => <Host key={c.nodeId} ctx={c} />)}</>)
  await settle()
  return r
}
type Mods = { meta?: boolean; alt?: boolean; shift?: boolean }
const press = (c: FilesSlotCtx, key: string, m: Mods = {}) =>
  mutateSlot.onKey!({ key, metaKey: !!m.meta, ctrlKey: false, altKey: !!m.alt, shiftKey: !!m.shift } as never, c)

const entries = [meta('src', true), meta('src/a.ts'), meta('src/b.ts'), meta('readme.md')]

beforeEach(() => { clearClip() })
afterEach(() => { cleanup(); vi.restoreAllMocks(); Object.values(fs).forEach((m) => m.mockReset()) })

describe('clipboard', () => {
  it('Cmd+C then Cmd+V on the same folder pastes as "name copy", then "name copy 2"', async () => {
    fs.copy.mockReturnValue(ok())
    const c = ctxFor('n1', '/proj', entries, ['src/a.ts'])
    await mount(c)
    expect(press(c, 'c', { meta: true })).toBe(true)
    expect(press(c, 'v', { meta: true })).toBe(true)
    await settle()
    expect(fs.copy).toHaveBeenLastCalledWith('/proj/src/a.ts', '/proj/src/a copy.ts')
    expect(c.refresh).toHaveBeenLastCalledWith('src/a copy.ts')
    expect(await screen.findByText('Pasted “a.ts”.')).toBeTruthy()
    // Listing now has the copy; a second paste picks the next free name.
    const c2 = { ...c, entries: [...entries, meta('src/a copy.ts')] }
    press(c2, 'v', { meta: true })
    await settle()
    expect(fs.copy).toHaveBeenLastCalledWith('/proj/src/a.ts', '/proj/src/a copy 2.ts')
    expect(getClip()?.mode).toBe('copy') // a copy can be pasted again
  })

  it('a race (EEXIST from the server) retries with the next copy name', async () => {
    fs.copy.mockReturnValueOnce(Promise.resolve({ ok: false, code: 'EEXIST', error: 'x' })).mockReturnValue(ok())
    const c = ctxFor('n1', '/proj', entries, ['readme.md'])
    await mount(c)
    press(c, 'c', { meta: true })
    press({ ...c, selection: ['src'] }, 'v', { meta: true }) // paste INTO the selected folder
    await settle()
    expect(fs.copy.mock.calls).toEqual([['/proj/readme.md', '/proj/src/readme.md'], ['/proj/readme.md', '/proj/src/readme copy.md']])
  })

  it('Cmd+X dims the row, Cmd+V into a folder moves it (rename) and clears the dim', async () => {
    fs.rename.mockReturnValue(ok())
    const c = ctxFor('n1', '/proj', entries, ['readme.md'])
    await mount(c)
    press(c, 'x', { meta: true })
    expect(mutateSlot.decorate!(meta('readme.md'), c)).toEqual({ className: 'files-row--cut' })
    expect(mutateSlot.decorate!(meta('src/a.ts'), c)).toBeUndefined()
    press({ ...c, selection: ['src/a.ts'] }, 'v', { meta: true }) // file selected -> its folder
    await settle()
    expect(fs.rename).toHaveBeenCalledWith('/proj/readme.md', '/proj/src/readme.md', false)
    expect(getClip()).toBeNull()
    expect(mutateSlot.decorate!(meta('readme.md'), c)).toBeUndefined()
    expect(await screen.findByText('Moved “readme.md”.')).toBeTruthy()
  })

  it('Escape clears a pending cut (and is released when there is none)', async () => {
    const c = ctxFor('n1', '/proj', entries, ['readme.md'])
    await mount(c)
    expect(press(c, 'Escape')).toBe(false)
    press(c, 'x', { meta: true })
    expect(press(c, 'Escape')).toBe(true)
    expect(getClip()).toBeNull()
  })

  it('cut in one Files node, paste in another (different cwd) moves across nodes', async () => {
    fs.rename.mockReturnValue(ok())
    const a = ctxFor('na', '/proj', entries, ['src/a.ts'])
    const b = ctxFor('nb', '/other', [meta('a.ts')], [])
    await mount(a, b)
    press(a, 'x', { meta: true })
    press(b, 'v', { meta: true }) // nothing selected -> cwd; "a.ts" taken -> "a copy.ts"
    await settle()
    expect(fs.rename).toHaveBeenCalledWith('/proj/src/a.ts', '/other/a copy.ts', false)
    expect(b.refresh).toHaveBeenCalledWith('a copy.ts')
  })

  it('the SOURCE node of a cross-node move reloads too (local fs events under its tree)', async () => {
    fs.rename.mockReturnValue(ok())
    const a = ctxFor('na', '/proj', entries, ['readme.md'])
    const b = ctxFor('nb', '/other', [], [])
    await mount(a, b)
    press(a, 'x', { meta: true })
    press(b, 'v', { meta: true })
    await settle()
    expect(a.refresh).toHaveBeenCalledTimes(1)
  })

  it('menu: Cut/Copy with a selection, Paste only once something is on the clipboard', async () => {
    const c = ctxFor('n1', '/proj', entries, ['readme.md'])
    await mount(c)
    const labels = (x: FilesSlotCtx) => mutateSlot.menu!(x).flatMap((r) => ('label' in r ? [r.label] : []))
    expect(labels(c)).toEqual(expect.arrayContaining(['Cut', 'Copy']))
    expect(labels(c)).not.toContain('Paste')
    expect(labels({ ...c, selection: [] })).toEqual([])
    press(c, 'c', { meta: true })
    expect(labels(c)).toContain('Paste')
    expect(labels({ ...c, selection: [] })).toEqual(['Paste'])
  })
})

describe('undo', () => {
  it('Cmd+Z after a move renames it back; nothing left -> key released', async () => {
    fs.rename.mockReturnValue(ok())
    const c = ctxFor('n1', '/proj', entries, ['readme.md'])
    await mount(c)
    press(c, 'x', { meta: true })
    press({ ...c, selection: ['src'] }, 'v', { meta: true })
    await settle()
    expect(press(c, 'z', { meta: true })).toBe(true)
    await settle()
    expect(fs.rename).toHaveBeenLastCalledWith('/proj/src/readme.md', '/proj/readme.md', false)
    expect(c.refresh).toHaveBeenLastCalledWith('readme.md')
    expect(press(c, 'z', { meta: true })).toBe(false)
  })

  it('undo of a copy trashes the copy (toast Undo, then Cmd+Z does not repeat it)', async () => {
    fs.copy.mockReturnValue(ok())
    fs.remove.mockReturnValue(ok({ trashId: 't' }))
    const c = ctxFor('n1', '/proj', entries, ['readme.md'])
    await mount(c)
    press(c, 'c', { meta: true })
    press(c, 'v', { meta: true })
    await settle()
    fireEvent.click(await screen.findByText('Undo'))
    await settle()
    expect(fs.remove).toHaveBeenCalledWith('/proj/readme copy.md', false)
    expect(press(c, 'z', { meta: true })).toBe(false)
  })

  it('undo of an inline rename renames back', async () => {
    fs.rename.mockReturnValue(ok())
    const c = ctxFor('n1', '/proj', entries, ['src/a.ts'])
    await mount(c)
    press(c, 'F2')
    const req = vi.mocked(c.startInput).mock.calls[0][0] as Extract<InputRequest, { kind: 'rename' }>
    expect(req).toMatchObject({ kind: 'rename', initial: 'a.ts', at: 'src/a.ts' })
    await act(async () => { await req.onCommit('z.ts') })
    expect(fs.rename).toHaveBeenCalledWith('/proj/src/a.ts', '/proj/src/z.ts', false)
    press(c, 'z', { meta: true })
    await settle()
    expect(fs.rename).toHaveBeenLastCalledWith('/proj/src/z.ts', '/proj/src/a.ts', false)
  })

  it('undo of a trash restores it', async () => {
    fs.remove.mockReturnValue(ok({ trashId: 't-9' }))
    fs.restore.mockReturnValue(ok({ path: '/proj/readme.md' }))
    const c = ctxFor('n1', '/proj', entries, ['readme.md'])
    await mount(c)
    press(c, 'Delete')
    fireEvent.click(within(await screen.findByRole('dialog')).getByText('Move to Trash'))
    await settle()
    press(c, 'z', { meta: true })
    await settle()
    expect(fs.restore).toHaveBeenCalledWith('t-9')
    expect(await screen.findByText('Restored “readme.md”.')).toBeTruthy()
  })

  it(`the stack keeps only the last ${UNDO_LIMIT} entries`, () => {
    for (let i = 0; i < UNDO_LIMIT + 5; i++) pushUndo('cap', { kind: 'copy', paths: [`/p/${i}`] })
    let n = 0
    let last
    for (let e = popUndo('cap'); e; e = popUndo('cap')) { n++; last = e }
    expect(n).toBe(UNDO_LIMIT)
    expect(last).toEqual({ kind: 'copy', paths: ['/p/5'] })
  })
})

describe('delete keys', () => {
  it('Cmd+Backspace asks to move to Trash, then trashes', async () => {
    fs.remove.mockReturnValue(ok({ trashId: 't' }))
    const c = ctxFor('n1', '/proj', entries, ['src/a.ts'])
    await mount(c)
    expect(press(c, 'Backspace', { meta: true })).toBe(true)
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Move “a.ts” to Trash?')).toBeTruthy()
    expect(fs.remove).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByText('Move to Trash'))
    await settle()
    expect(fs.remove).toHaveBeenCalledWith('/proj/src/a.ts', false)
  })

  it('failures name the file, adding the folder only when two rows share a name', async () => {
    fs.remove.mockReturnValue(Promise.resolve({ ok: false, code: 'EACCES', error: 'x' }))
    const c = ctxFor('n1', '/proj', [], ['src/index.ts', 'lib/index.ts', 'src/a.ts'])
    await mount(c)
    press(c, 'Delete')
    fireEvent.click(within(await screen.findByRole('dialog')).getByText('Move to Trash'))
    await settle()
    const text = (await screen.findByText('3 of 3 items failed.')).closest('[role]')?.textContent ?? document.body.textContent
    expect(text).toContain('Could not delete “index.ts (src)”.')
    expect(text).toContain('Could not delete “index.ts (lib)”.')
    expect(text).toContain('Could not delete “a.ts”.')
    expect(text).not.toContain('“src/a.ts”')
  })

  it.each([[{ meta: true, alt: true }, 'Backspace'], [{ shift: true }, 'Delete']] as const)('%o+%s asks for permanent delete', async (m, k) => {
    fs.remove.mockReturnValue(ok())
    const c = ctxFor('n1', '/proj', entries, ['readme.md'])
    await mount(c)
    expect(press(c, k, m)).toBe(true)
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Permanently delete “readme.md”?')).toBeTruthy()
    fireEvent.click(within(dialog).getByText('Delete Permanently'))
    await settle()
    expect(fs.remove).toHaveBeenCalledWith('/proj/readme.md', true)
  })
})
