import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Chrome workspace SESUDAH migrasi ke primitif VS Code. Vitest webterm jalan di node-env tanpa
// DOM, jadi yang dibaca adalah source-nya — pola yang sama dengan `workspaceCommit.test.ts` dan
// `sidebarChrome.test.ts`. Yang dijaga di sini adalah kontrak yang paling mudah diam-diam rusak:
//
//   1. Title bar 35px memakai `VscodeMenuBar`, editor tabs 35px memakai `VscodeEditorTabBar`.
//   2. Rename/hapus workspace tetap terjangkau (File menu + tab context menu) dan rename tetap Enter/Escape/blur.
//   3. Status dot tetap milik workspace, bukan penanda tab aktif.
//   4. CSS tab buatan sendiri yang sudah mati tidak kembali.
const src = (f: string) => readFileSync(fileURLToPath(new URL(`./${f}`, import.meta.url)), 'utf8')

/** Badan satu aturan CSS, dari selektornya sampai `}` pertama. String kosong kalau tak ada. */
const rule = (css: string, selector: string): string => {
  const at = css.indexOf(`\n${selector} {`)
  return at === -1 ? '' : css.slice(at + selector.length + 3).split('}')[0]
}

const bar = src('WorkspaceBar.tsx')
const css = src('styles.css')
const dot = src('WorkspaceTabDot.tsx')
const wsCss = src('workspaceColor.css')
const tabBar = src('components/vscode/vscodeEditorTabBar.tsx')

describe('title bar & editor tabs memakai primitif VS Code', () => {
  it('title bar merender `VscodeMenuBar` dan tab strip `VscodeEditorTabBar`', () => {
    expect(bar).toContain("from '@/components/vscode/vscodeMenuBar'")
    expect(bar).toContain("from '@/components/vscode/vscodeEditorTabBar'")
    expect(bar).toMatch(/<VscodeMenuBar[\s\S]{0,160}?menus=\{menus\}/)
    expect(bar).toMatch(/<VscodeEditorTabBar[\s\S]{0,200}?tabs=\{tabs\}/)
    expect(bar).toMatch(/<VscodeEditorTabBar[\s\S]{0,400}?onActivate=\{onSelect\}/)
  })

  it('peran/perilaku tab tidak dipasang tangan lagi', () => {
    // `role="tab"`, `aria-selected`, dan `tabIndex` milik primitif.
    expect(bar).not.toContain('role="tablist"')
    expect(bar).not.toContain('role="tab"')
    expect(bar).not.toContain('aria-selected=')
    expect(bar).not.toContain('tabIndex=')
    // Implementasi Radix/shadcn dan scroll buatan sendiri sudah dibuang.
    expect(bar).not.toContain("from '@/components/ui/tabs'")
    expect(bar).not.toContain('TabsTrigger')
    expect(bar).not.toContain('addEventListener(\'wheel\'')
  })

  it('tinggi kedua baris datang dari token VS Code, bukan angka lokal', () => {
    // `.app-shell` memakai token ini untuk baris grid; nilainya dipaku di styles.test.ts.
    expect(rule(css, '.app-titlebar')).toContain('grid-area: title')
    expect(rule(css, '.app-tabs')).toContain('grid-area: tabs')
    expect(rule(css, '.app-tabs')).toContain('display: flex')
    // Strip primitif dibiarkan menyusut;aksi baris tidak.
    const strip = css.slice(css.indexOf('.app-tabs > .vscode-editor-tabs'))
    expect(strip.slice(0, strip.indexOf('}'))).toContain('min-width: 0')
    expect(rule(css, '.app-tabs__action')).toContain('width: 35px')
  })
})

describe('rename & hapus workspace tetap terjangkau', () => {
  it('menu File/View/Help memuat New/Rename/Delete/Settings dan Keyboard Shortcuts Reference', () => {
    expect(bar).toContain("label: 'File'")
    expect(bar).toContain("label: 'Help'")
    expect(bar).toContain("label: 'Keyboard Shortcuts Reference'")
    expect(bar).toContain("label: 'Settings…'")
    expect(bar).not.toContain("label: 'Workspace'")
    // View hanya boleh berisi aksi nyata (Output / Clear Output); menu View kosong tetap dilarang.
    expect(bar).toContain("label: 'View'")
    expect(bar).toContain("label: 'Clear Output'")
    expect(bar).toContain("label: 'New Workspace'")
    expect(bar).toContain("label: 'Rename Workspace…'")
    expect(bar).toContain("label: 'Delete Workspace'")
    // Hapus tetap lewat satu konfirmasi.
    expect(bar).toContain('deleteWorkspaceMessage(')
    expect(bar).toContain('window.confirm(')
  })

  it('tab context menu membuka permukaan Rename/Delete yang sama; tidak ada kebab', () => {
    expect(bar).not.toContain('aria-label="Workspace options"')
    const tabMenu = src('WorkspaceTabMenu.tsx') // the tab menu rows live in their own component
    expect(bar).toContain('<WorkspaceTabMenu')
    expect(tabMenu).toContain("label: 'Rename'")
    expect(tabMenu).toContain("label: 'Delete'")
    expect(tabMenu).toContain('<NodeContextMenu')
    expect(bar).toMatch(/<VscodeEditorTabBar[\s\S]{0,400}?onContextMenu=/)
  })

  it('rename inline di tab: Enter simpan, Escape batal, blur simpan', () => {
    const rename = src('WorkspaceTabRename.tsx')
    expect(rename).toContain('aria-label="Workspace name"')
    expect(rename).toContain("if (e.key === 'Enter') commit()")
    expect(rename).toContain("if (e.key === 'Escape') close()")
    expect(rename).toContain('onBlur={commit}')
    expect(bar).not.toContain('app-titlebar__rename')
    expect(rule(css, '.app-tab-rename__input')).toContain('height: 22px')
  })

  it('`+` workspace baru duduk di dalam strip, setelah tab terakhir (trailing)', () => {
    const strip = bar.slice(bar.indexOf('<VscodeEditorTabBar'), bar.indexOf('{onToggleLayout && activeGroup && ('))
    expect(strip).toContain('trailing={')
    expect(strip).toContain('aria-label="New workspace"')
    expect(rule(css, '.app-tabs__action')).toContain('width: 35px')
  })
})

describe('status dot tetap milik workspace', () => {
  it('dot dipetakan dari `workspaceTabDot`, bukan dari keterpilihan', () => {
    expect(bar).toContain('workspaceTabFields(g')
    expect(dot).toContain('workspaceTabDot(group)')
    expect(dot).toContain('ws-dot__badge ws-dot__badge--')
    // Tidak ada lagi kelas tab aktif buatan sendiri.
    expect(bar).not.toContain('tab--active')
  })

  it('lencana status memakai token status; titik memakai token warna workspace, bukan status', () => {
    expect(wsCss).toContain('.ws-dot__badge--working { background: var(--state-working); }')
    expect(wsCss).toContain('.ws-dot__badge--attention { background: var(--state-attention); }')
    expect(wsCss).toContain('background: var(--ws-dot, var(--ws-slate-default))')
    expect(css).not.toContain('.tab__dot')
  })

  it('tab tidak punya penanda garis warna (bar bawah, border-top aksen, data-accent)', () => {
    expect(wsCss).not.toMatch(/vscode-editor-tab\[data-accent/)
    expect(wsCss).not.toContain('--tab-accent')
    expect(tabBar).not.toContain('data-accent')
    expect(tabBar).not.toContain('tab-accent')
    expect(bar).not.toContain('accent:')
  })
})

describe('CSS tab lama sudah dibuang', () => {
  it('tidak ada lagi selektor tab buatan sendiri', () => {
    for (const gone of [
      '.tabbar {',
      '.tabbar__tabs',
      '.tabbar__projects',
      '.tab--active',
      '.tab__caret',
      '.tab__edit',
      '.tab__add',
      '.tab__actions',
    ]) {
      expect(css).not.toContain(gone)
    }
  })

  it('guard benar-benar menggigit: bentuk lama dikenali', () => {
    const legacy = '.tabbar {\n  position: relative;\n}\n.tab__caret { opacity: 0.45; }'
    expect(legacy).toContain('.tabbar {')
    expect(legacy).toContain('.tab__caret')
  })
})
