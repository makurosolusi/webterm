import { describe, expect, it, vi } from 'vitest'
import type { VscodeMenuItem } from '@/components/vscode/vscodeMenu'
import type { ContextInfo } from '../../shared/browser.contextmenu'
import { contextMenuItems } from './browserContextMenu.items'
import type { ContextMenuDeps } from './browserContextMenu.items'

const deps = (over: Partial<ContextMenuDeps> = {}): ContextMenuDeps => ({
  canBack: true, canForward: false, nav: vi.fn(), openLink: vi.fn(), copyText: vi.fn(), copySelection: vi.fn(), cut: vi.fn(), paste: vi.fn(), ...over,
})
const rows = (items: VscodeMenuItem[]) => items.flatMap((i) => (i.type === 'item' ? [i] : []))
const labels = (items: VscodeMenuItem[]) => rows(items).map((i) => i.label)
const plain: ContextInfo = { selection: false, editable: false }
const everything: ContextInfo = { link: { href: 'https://l.test/a', text: 'a' }, image: 'https://l.test/i.png', selection: true, editable: true }

describe('browser node context menu rows', () => {
  it('a plain page offers Back, Forward and Reload only, with unavailable steps disabled', () => {
    const items = rows(contextMenuItems(plain, deps()))
    expect(items.map((i) => [i.label, !!i.disabled])).toEqual([['Back', false], ['Forward', true], ['Reload', false]])
  })

  it('a link offers a tab in this node and the address, and runs them with the link', () => {
    const d = deps()
    const items = rows(contextMenuItems({ ...plain, link: { href: 'https://l.test/a', text: 'a' } }, d))
    expect(labels(items).slice(0, 2)).toEqual(['Open link in new tab', 'Copy link address'])
    items[0].onSelect?.()
    items[1].onSelect?.()
    expect(d.openLink).toHaveBeenCalledWith('https://l.test/a')
    expect(d.copyText).toHaveBeenCalledWith('https://l.test/a')
  })

  it('an image offers its address; a selection offers Copy; an editable field offers Cut, Copy, Paste', () => {
    expect(labels(contextMenuItems({ ...plain, image: 'https://l.test/i.png' }, deps()))).toContain('Copy image address')
    expect(labels(contextMenuItems({ ...plain, selection: true }, deps()))).toContain('Copy')
    const edit = rows(contextMenuItems({ ...plain, editable: true }, deps()))
    expect(edit.slice(0, 3).map((i) => [i.label, !!i.disabled])).toEqual([['Cut', true], ['Copy', true], ['Paste', false]]) // nothing selected yet
  })

  it('no row opens anything outside the canvas (the system-browser exit lives only in the toolbar menu)', () => {
    for (const info of [plain, everything, { ...plain, link: everything.link }]) {
      for (const label of labels(contextMenuItems(info, deps()))) expect(label).not.toMatch(/system|external|window|default browser/i)
    }
    expect(labels(contextMenuItems(everything, deps()))).not.toContain('Open in system browser')
  })
})
