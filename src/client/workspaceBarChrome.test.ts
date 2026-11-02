import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Chrome workspace SESUDAH migrasi ke primitif VS Code. Vitest webterm jalan di node-env tanpa
// DOM, jadi yang dibaca adalah source-nya — pola yang sama dengan `workspaceCommit.test.ts` dan
// `sidebarChrome.test.ts`. Yang dijaga di sini adalah kontrak yang paling mudah diam-diam rusak:
//
//   1. Title bar 35px memakai `VscodeMenuBar`, editor tabs 35px memakai `VscodeEditorTabBar`.
//   2. Rename/hapus workspace tetap terjangkau (menu + kebab) dan rename tetap Enter/Escape/blur.
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
  it('menu File/Workspace memuat New/Rename/Delete', () => {
    expect(bar).toContain("label: 'File'")
    expect(bar).toContain("label: 'Workspace'")
    expect(bar).toContain("label: 'New Workspace'")
    expect(bar).toContain("label: 'Rename Workspace…'")
    expect(bar).toContain("label: 'Delete Workspace'")
    // Hapus tetap lewat satu konfirmasi.
    expect(bar).toContain('deleteWorkspaceMessage(')
    expect(bar).toContain('window.confirm(')
  })

  it('kebab baris tab membuka permukaan Rename/Delete yang sama', () => {
    expect(bar).toContain('aria-label="Workspace options"')
    expect(bar).toContain("label: 'Rename'")
    expect(bar).toContain("label: 'Delete'")
    expect(bar).toContain('<NodeContextMenu')
  })

  it('rename tetap Enter simpan, Escape batal, blur simpan', () => {
    const at = bar.indexOf('className="app-titlebar__rename"')
    const input = bar.slice(at, bar.indexOf('/>', at))
    expect(input).toContain('aria-label="Workspace name"')
    expect(input).toContain("if (e.key === 'Enter') commitRename()")
    expect(input).toContain("if (e.key === 'Escape') setEditingId(null)")
    expect(input).toContain('onBlur={commitRename}')
    // Input hidup di command center title bar, bukan di dalam tab yang menggulung.
    expect(rule(css, '.app-titlebar__rename')).toContain('width: min(320px, 40vw)')
  })

  it('`+` workspace baru adalah saudara strip, bukan anaknya', () => {
    const tabs = bar.slice(bar.indexOf('<div className="app-tabs">'))
    const actionAt = tabs.indexOf('aria-label="New workspace"')
    const stripClose = tabs.indexOf('</VscodeEditorTabBar>')
    expect(actionAt).toBeGreaterThan(stripClose)
    expect(rule(css, '.app-tabs__action')).toContain('width: 35px')
  })
})

describe('status dot tetap milik workspace', () => {
  it('dot dipetakan dari `workspaceTabDot`, bukan dari keterpilihan', () => {
    expect(bar).toContain('workspaceTabDot(g)')
    expect(bar).toContain('tab__dot tab__dot--')
    // Tidak ada lagi kelas tab aktif buatan sendiri.
    expect(bar).not.toContain('tab--active')
  })

  it('setiap jenis dot tetap punya warna dari token status', () => {
    for (const [state, token] of [
      ['idle', '--state-queued'],
      ['working', '--state-working'],
      ['attention', '--state-attention'],
    ]) {
      expect(css).toContain(`.tab__dot--${state} { background: var(${token}); }`)
    }
    expect(css).toContain('.tab__dot--neutral {')
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
