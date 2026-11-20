// Spesifikasi fidelity dialog/dock (gelombang 2): nilai terukur VS Code yang bisa dijaga di jsdom
// lewat teks CSS — jsdom tak punya layout, jadi inilah yang menjaga angka agar tak melenceng.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { joinPath } from './FolderPicker'

const css = (name: string): string => readFileSync(join(__dirname, name), 'utf8')
const rule = (src: string, selector: string): string => {
  const start = src.indexOf(`${selector} {`)
  if (start < 0) throw new Error(`selector tak ada: ${selector}`)
  return src.slice(start, src.indexOf('}', start))
}

describe('joinPath', () => {
  it('tidak menggandakan slash di akar', () => {
    expect(joinPath('/', 'usr')).toBe('/usr')
    expect(joinPath('/home/u', 'src')).toBe('/home/u/src')
    expect(joinPath('/home/u/', 'src')).toBe('/home/u/src')
  })
})

describe('toggle Lock/Clean di dock', () => {
  const dock = css('dock.css')
  it('tanpa marker aktif ala tab; aktif hanya mengganti warna', () => {
    const pressed = rule(dock, ".dock-btn[aria-pressed='true']")
    expect(pressed).toContain('color: var(--vscode-activityBar-foreground)')
    expect(pressed).not.toContain('box-shadow')
    expect(pressed).not.toContain('border')
  })
  it('warna idle seragam dengan item activity bar', () => {
    expect(rule(dock, '.dock__modes')).toContain('color: var(--vscode-activityBar-inactiveForeground)')
  })
})

describe('FolderPicker', () => {
  const fp = css('folderPicker.css')
  it('path tidak rtl dan membungkus alih-alih memotong awal', () => {
    expect(fp).not.toContain('direction: rtl')
    expect(rule(fp, '.fp-path')).toContain('overflow-wrap: anywhere')
  })
  it('tombol mengikuti skala VS Code 26px / radius 4', () => {
    const btn = rule(fp, '.fp-button')
    expect(btn).toContain('min-height: 26px')
    expect(btn).toContain('border-radius: 4px')
  })
})

describe('Welcome & HelpOverlay', () => {
  it('label Welcome tak membungkus', () => {
    const w = css('welcome.css')
    expect(w).toContain('white-space: nowrap')
    expect(rule(w, '.welcome__empty-row')).toContain('flex-wrap: wrap')
  })
  it('kolom keybinding HelpOverlay menyusut ke isi, tanpa hyphenation', () => {
    const h = css('helpOverlay.css')
    expect(h).toContain('hyphens: none')
    expect(h).toContain('width: 1%')
  })
})

describe('dialog approval', () => {
  const a = css('inboxApprovalDialog.css')
  it('skala dialog VS Code: 480, judul 14/600, tombol 26px', () => {
    expect(rule(a, '.approval-dialog')).toContain('width: 480px')
    const title = rule(a, '.approval-dialog__title')
    expect(title).toContain('font-size: 14px')
    expect(title).toContain('font-weight: 600')
    expect(rule(a, '.approval-dialog__btn')).toContain('height: 26px')
  })
  it('checkbox 18x18 radius 3 dan input 25px', () => {
    const c = rule(a, '.approval-dialog__check')
    expect(c).toContain('width: 18px')
    expect(c).toContain('border-radius: 3px')
    expect(rule(a, '.approval-dialog__input')).toContain('height: 25px')
  })
})
