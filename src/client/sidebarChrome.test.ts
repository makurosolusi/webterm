import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Yang dijaga di sini hidup di JSX `SessionsPanel.tsx`: judul yang ikut tab, seksi kosong yang
// disembunyikan, dan ikon kind per baris. Vitest webterm jalan di node-env tanpa DOM, jadi tidak
// ada komponen yang bisa dirender untuk membuktikannya. Yang bisa dilakukan: membaca source-nya
// dan menolak bentuk yang salah — pola yang sama dengan `workspaceCommit.test.ts`.
const src = (f: string) => readFileSync(fileURLToPath(new URL(`./${f}`, import.meta.url)), 'utf8')

/** Judul panel harus menamai himpunan yang benar-benar didaftar, dan hitungannya harus `rowCount`
 *  (per tab) — bukan `total`, yang selalu menghitung sesi. */
const titleFollowsTab = (s: string) =>
  /sessions-sidebar__title">\{[^}]*'Nodes'[^}]*\}/.test(s) &&
  /sessions-sidebar__count">\{rowCount\}/.test(s)

/** Blok render tab Status: dari gerbang `empty === 'none'` sampai pemetaan section-nya. */
const statusGate = (s: string) => s.split("empty === 'none'")[1]?.split('.map((s) =>')[0] ?? ''

/** Seksi kosong dibuang, KECUALI `attention` — nol di sana adalah kabar baik yang dicari. */
const hidesEmptySectionsButAttention = (s: string) => {
  const gate = statusGate(s)
  return /\.filter\(/.test(gate) && /'attention'/.test(gate) && /rows\.length > 0/.test(gate)
}

/** Blok render tab Nodes, dari gerbang tabnya sampai cabang Status. */
const nodesBranch = (s: string) =>
  s.split("{grouping === 'nodes' ? (")[1]?.split(") : grouping === 'status'")[0] ?? ''

/** Tab Nodes dirender sebagai branch tree per grup; barisnya leaf tree, bukan daftar pipih. */
const rendersNodeSections = (s: string) => {
  const b = nodesBranch(s)
  return (
    /nodeGroups\.map\(/.test(b) &&
    /<SessionGroupItem/.test(b) &&
    /label=\{g\.label\}/.test(b) &&
    /count=\{g\.rows\.length\}/.test(b) &&
    /<TreeItem/.test(b) &&
    b.includes('ss-tree__leaf')
  )
}

/** Tanpa baris meta: kind sudah dinyatakan header seksi + ikon baris, dan daftar ini satu board
 *  saja jadi nama workspace tak membedakan apa pun. Dijaga di sini karena `ss-meta` yang lain di
 *  file yang sama (tab Project, Recently closed) memang membawa nama workspace. */
const nodeRowsHaveNoMeta = (s: string) => !nodesBranch(s).includes('ss-meta')

/** Ikon kind duduk di slot ikon leaf milik tree item, supaya rata dengan glyph sesi. */
const rowsHaveKindGlyph = (s: string) => {
  const b = nodesBranch(s)
  return /slot="icon-leaf"/.test(b) && /<KindIcon kind=\{g\.kind\} \/>/.test(b)
}

// Bentuk lama, persis seperti sebelum dibetulkan. Dipakai untuk membuktikan guard di atas
// benar-benar menggigit, bukan lulus karena polanya mustahil ditemukan.
const OLD_HEAD = `        <span className="sessions-sidebar__title">Sessions</span>
        <span className="sessions-sidebar__count">{total}</span>`
const OLD_STATUS_GATE = `          ? // komentar lama
            empty === 'none' &&
            sections.map((s) => (
              <section key={s.kind} className="ss-status" aria-label={s.label}>`
const OLD_NODES_BRANCH = `        {grouping === 'nodes' ? (
          <ul className="ss-rows ss-status__rows">
            {nodeRows.map((r) => (
              <li key={r.id}>
                <div className="ss-row" role="button" tabIndex={0} aria-label={\`Focus \${r.label}\`}>
                  <span className="ss-row__text">
                    <span className="ss-row__title">{r.label}</span>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        ) : grouping === 'status'`
/** Bentuk sebelum meta dibuang — baris yang mengulang kind-nya di bawah judulnya sendiri. */
const OLD_NODES_META = `        {grouping === 'nodes' ? (
          nodeGroups.map((g) => (
            <span className="ss-row__text">
              <span className="ss-row__title">{r.label}</span>
              <span className="ss-meta">{NODE_KIND_LABEL[r.kind]}</span>
            </span>
          ))
        ) : grouping === 'status'`

describe('judul sidebar', () => {
  it('menamai dan menghitung himpunan yang benar-benar didaftar tab aktif', () => {
    expect(titleFollowsTab(src('SessionsPanel.tsx'))).toBe(true)
  })

  it('guard menolak judul tetap "Sessions" dengan hitungan sesi', () => {
    expect(titleFollowsTab(OLD_HEAD)).toBe(false)
  })
})

describe('seksi status kosong', () => {
  it('disembunyikan, kecuali Need attention', () => {
    const panel = src('SessionsPanel.tsx')
    // Dihitung dulu: blok yang tidak ketemu memulangkan string kosong, dan guard apa pun di
    // atasnya akan lulus/gagal tanpa menjaga apa pun.
    expect(statusGate(panel).length).toBeGreaterThan(0)
    expect(hidesEmptySectionsButAttention(panel)).toBe(true)
  })

  it('guard menolak bentuk lama yang merender kelima header apa pun isinya', () => {
    expect(statusGate(OLD_STATUS_GATE).length).toBeGreaterThan(0)
    expect(hidesEmptySectionsButAttention(OLD_STATUS_GATE)).toBe(false)
  })

  it('header attention tetap dirender saat nol — jadi badan barisnya masih digerbang sendiri', () => {
    expect(src('SessionsPanel.tsx')).toMatch(/\{s\.rows\.length > 0 && \(/)
  })
})

describe('tab Nodes', () => {
  it('dirender sebagai seksi per grup dengan kelas yang sama seperti tab Status', () => {
    const panel = src('SessionsPanel.tsx')
    expect(nodesBranch(panel).length).toBeGreaterThan(0)
    expect(rendersNodeSections(panel)).toBe(true)
  })

  it('hitungan panelnya menjumlahkan baris lintas grup, bukan panjang satu daftar datar', () => {
    const panel = src('SessionsPanel.tsx')
    expect(panel).toMatch(/nodeGroups\.reduce\(\(n, g\) => n \+ g\.rows\.length, 0\)/)
    expect(panel).not.toContain('nodeRows')
  })

  it('setiap baris membawa ikon kind di slot glyph yang sudah ada', () => {
    expect(rowsHaveKindGlyph(src('SessionsPanel.tsx'))).toBe(true)
  })

  it('ikonnya dipetakan per kind, keempatnya, ke codicon (bukan lucide-react)', () => {
    const panel = src('SessionsPanel.tsx')
    for (const [kind, icon] of [
      ['agent', 'hubot'],
      ['terminal', 'terminal'],
      ['editor', 'file'],
      ['files', 'folder'],
    ]) {
      expect(panel).toMatch(new RegExp(String.raw`\b${kind}: '${icon}',`))
    }
    expect(panel).not.toContain('lucide-react')
    expect(src('SessionRow.tsx')).not.toContain('lucide-react')
  })

  it('barisnya tidak mengulang kind di baris meta', () => {
    const panel = src('SessionsPanel.tsx')
    expect(nodesBranch(panel).length).toBeGreaterThan(0)
    expect(nodeRowsHaveNoMeta(panel)).toBe(true)
    // `ss-meta` di luar blok Nodes (tab Project, Recently closed) harus tetap ada: yang dibawanya
    // nama workspace, bukan kind. Tanpa ini guard di atas bisa "lulus" dengan menyapu semuanya.
    expect(panel).toContain('ss-meta')
  })

  it('guard meta merah pada bentuk lama yang mencetak NODE_KIND_LABEL per baris', () => {
    expect(nodesBranch(OLD_NODES_META).length).toBeGreaterThan(0)
    expect(nodeRowsHaveNoMeta(OLD_NODES_META)).toBe(false)
  })

  it('guard menolak daftar datar tanpa seksi dan tanpa ikon', () => {
    expect(nodesBranch(OLD_NODES_BRANCH).length).toBeGreaterThan(0)
    expect(rendersNodeSections(OLD_NODES_BRANCH)).toBe(false)
    expect(rowsHaveKindGlyph(OLD_NODES_BRANCH)).toBe(false)
  })
})

describe('meta baris sesi', () => {
  it('SessionRow memanggil `rowMeta`, tidak lagi menyusun metanya sendiri', () => {
    const row = src('SessionRow.tsx')
    expect(row).toMatch(/const meta = rowMeta\(showProject \? row\.projectName : undefined, row\.cwd\)/)
    // `dirName` pindah ke `sessionList` supaya bisa dites; salinan kedua di sini akan menua sendiri.
    expect(row).not.toContain('function dirName')
  })
})
