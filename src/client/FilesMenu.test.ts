import { describe, expect, it, vi } from 'vitest'
import type { VscodeMenuItem } from './components/vscode/vscodeMenu'
import { buildMenuItems, revealLabel, type FilesMenuActions } from './FilesMenu'

const actions = (): FilesMenuActions => ({
  open: vi.fn(), terminal: vi.fn(), newEntry: vi.fn(), refresh: vi.fn(), reveal: vi.fn(), copyPath: vi.fn(),
})
const items = (list: VscodeMenuItem[]) => list.filter((i): i is Extract<VscodeMenuItem, { type: 'item' }> => i.type === 'item')
const mac = { isMac: true, isWindows: false }
const entry = { name: 'a.txt', dir: false, ignored: false }

describe('FilesMenu reveal', () => {
  it('uses the VS Code name per OS', () => {
    expect(revealLabel(mac)).toBe('Reveal in Finder')
    expect(revealLabel({ isMac: false, isWindows: true })).toBe('Reveal in File Explorer')
    expect(revealLabel({ isMac: false, isWindows: false })).toBe('Open Containing Folder')
  })

  it('targets the entry with ⌥⌘R and calls actions.reveal with it', () => {
    const a = actions()
    const row = items(buildMenuItems(entry, [], a, mac)).find((i) => i.label === 'Reveal in Finder')
    expect(row?.keybinding).toBe('⌥⌘R')
    row?.onSelect?.()
    expect(a.reveal).toHaveBeenCalledWith(entry)
  })

  it('is absent when no entry is targeted', () => {
    expect(items(buildMenuItems(null, [], actions(), mac)).map((i) => i.label)).not.toContain('Reveal in Finder')
  })
})
