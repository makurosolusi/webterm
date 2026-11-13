import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Yang dijaga di sini hidup di JSX side bar: judul yang ikut view, seksi kosong yang
// disembunyikan, dan ikon kind per baris. Vitest webterm jalan di node-env tanpa DOM, jadi tidak
// ada komponen yang bisa dirender untuk membuktikannya. Yang bisa dilakukan: membaca source-nya
// dan menolak bentuk yang salah — pola yang sama dengan `workspaceCommit.test.ts`.
const src = (f: string) => readFileSync(fileURLToPath(new URL(`./${f}`, import.meta.url)), 'utf8')
/** Panel dipecah: pohon JSX ada di `SessionsPanel.tree.tsx`; invarian dibaca dari gabungannya. */
const panelSrc = () => src('SessionsPanel.tsx') + src('SessionsPanel.tree.tsx')
/** Judul side bar = nama view yang tampil; badge hitungan hanya untuk LAYERS (jumlah node board). */
const titleFollowsView = (s: string) =>
  /\{SIDE_BAR_VIEW_TITLE\[view\]\}/.test(s) && /view === 'layers' && layerCount !== undefined && <span className="sessions-sidebar__count">/.test(s)

// Bentuk lama, persis seperti sebelum dibetulkan. Dipakai untuk membuktikan guard di atas
// benar-benar menggigit, bukan lulus karena polanya mustahil ditemukan.
const OLD_HEAD = `        <span className="sessions-sidebar__title">Sessions</span>
        <span className="sessions-sidebar__count">{total}</span>`
describe('judul sidebar', () => {
  it('menamai view yang tampil dan hanya LAYERS yang membawa hitungan', () => {
    expect(titleFollowsView(src('sideBar/SideBar.tsx'))).toBe(true)
  })

  it('guard menolak judul tetap "Sessions" dengan hitungan sesi', () => {
    expect(titleFollowsView(OLD_HEAD)).toBe(false)
  })
})

describe('seksi status kosong', () => {
  // Empty buckets are dropped by `buildStatusList` (see sessionList.test.ts); the tree must not
  // bring back the old "Need attention 0" exception header.
  it('the Status tab renders the sections as given, no attention exception', () => {
    const panel = panelSrc()
    expect(panel).toContain('p.sections.map((s) =>')
    expect(panel).not.toContain("s.kind === 'attention'")
  })
})

describe('tab Nodes dihapus', () => {
  it('tidak ada lagi cabang Nodes; daftar node pindah ke seksi Layers di side bar', () => {
    const panel = panelSrc() + src('SessionsGroupingTabs.tsx')
    expect(panel).not.toContain("'nodes'")
    expect(panel).not.toContain('nodeGroups')
    expect(panel).not.toContain('lucide-react')
    expect(src('SessionRow.tsx')).not.toContain('lucide-react')
  })
})

describe('strip tab node di atas canvas dihapus', () => {
  // Policy: daftar node board hanya hidup di seksi Layers side bar; strip kedua di atas canvas tak boleh kembali.
  it('BoardHost tidak merender `.node-tabs` dan modul strip-nya sudah tiada', () => {
    const host = src('BoardHost.tsx')
    expect(host).not.toContain('node-tabs')
    expect(host).not.toContain('canvasStrip')
    for (const f of ['tabLayout.canvasStrip.tsx', 'nodeTabs.visible.ts']) {
      expect(existsSync(fileURLToPath(new URL(`./${f}`, import.meta.url)))).toBe(false)
    }
    expect(src('tab-layout.css') + src('cleanView.css')).not.toContain('.node-tabs')
    expect(src('WorkspaceBar.tsx')).not.toContain('Show Node Tabs')
  })
})

describe('meta baris sesi', () => {
  it('SessionRow reads its description from `rowDescription`, not composing it itself', () => {
    const row = src('SessionRow.tsx')
    expect(row).toMatch(/const description = rowDescription\(row, mode, groupCwd\)/)
    // `dirName` lives in `sessionList` so it can be tested; a second copy here would drift.
    expect(row).not.toContain('function dirName')
  })
})

describe('G-11/G-12/G-18 CSS fidelity', () => {
  const css = (f: string) => src(f)

  it('badge hitungan sesi memakai token badge-* dan geometri VS Code (bukan pil 8px)', () => {
    const c = css('sessions-panel.css')
    const group = c.slice(c.indexOf('.sessions-sidebar__count,\n.ss-tree__count,\n.ss-signal {'))
    const block = group.slice(0, group.indexOf('}'))
    expect(block).toContain('border-radius: 2px')
    expect(block).toContain('height: var(--ss-badge-h)')
    expect(c).toMatch(/--ss-badge-h:\s*17px/)
    expect(c).not.toContain('border-radius: 8px')
    expect(c.match(/var\(--vscode-badge-background/g)?.length).toBe(2)
  })

  it('meta redup mengalah saat baris ber-aksi di-hover/di-fokus (aksi tak menimpa meta)', () => {
    const c = css('sessions-panel.css')
    // Any inline action (End session, Rename, ⋯, Restore) makes the meta and the time give way.
    expect(c).toContain('.ss-tree__leaf:has(.ss-tree__action):hover .ss-meta')
    expect(c).toContain('.ss-tree__leaf:has(.ss-tree__action):focus-within .ss-meta')
  })
})
