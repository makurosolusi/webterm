import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Yang dijaga di sini adalah PENANDA tab workspace terpilih. Sejak migrasi shadcn, penandanya
// bukan lagi aturan CSS buatan sendiri: `TabsTrigger` `variant="line"` milik `components/ui/tabs`
// menggambar garis bawah dari `data-state=active` dan membawa `aria-selected` dari Radix. Yang
// tersisa di sisi webterm adalah (a) kelas `tab--active` sebagai kait, (b) satu koreksi posisi
// garis, dan (c) bahwa strip-nya benar-benar memakai primitif itu. Vitest webterm jalan di
// node-env tanpa DOM, jadi tidak ada computed style yang bisa dibaca: source-nya yang diperiksa —
// pola yang sama dengan `workspaceCommit.test.ts` dan `sidebarChrome.test.ts`.
const src = (f: string) => readFileSync(fileURLToPath(new URL(`./${f}`, import.meta.url)), 'utf8')

/** Badan satu aturan CSS, dari selektornya sampai `}` pertama. String kosong kalau tak ada. */
const rule = (css: string, selector: string): string => {
  const at = css.indexOf(`\n${selector} {`)
  return at === -1 ? '' : css.slice(at + selector.length + 3).split('}')[0]
}

/**
 * Penanda terpilih tidak boleh kembali menjadi fill permukaan: bar `var(--panel)` dan fill apa pun
 * di atasnya berjarak empat tingkat dari 255, di bawah ambang yang bisa dilihat mata. Garis
 * (kanal bentuk) yang dipakai sekarang; fill dan bayangan adalah bentuk lama yang gagal.
 */
const hasNoSurfaceFill = (body: string): boolean =>
  body.length > 0 && !/^\s*background\s*:/m.test(body) && !/box-shadow/.test(body)

/**
 * `TabsTrigger` varian line menaruh garisnya di `bottom: -5px`, di luar kotak tab, dan strip ini
 * adalah kontainer `overflow-x: auto` yang meng-clip sumbu Y. Garis harus digeser ke tepi bawah
 * kotak tab sendiri supaya terlihat utuh.
 */
const underlineSitsInsideTab = (css: string): boolean => {
  const at = css.indexOf(".tabbar__tabs [data-slot='tabs-trigger']::after")
  if (at === -1) return false
  return /bottom:\s*0\s*;/.test(css.slice(at).split('}')[0])
}

/**
 * Tab aktif yang di-hover tetap terbaca aktif. `.tab:hover` punya spesifisitas lebih tinggi
 * daripada `.tab--active`, jadi aturan hover TANPA `:not()` menimpa penandanya justru saat
 * pointer ada di atasnya.
 */
const hoverSparesActive = (css: string) =>
  /\.tab:not\(\.tab--active\):hover \{/.test(css) && !/\n\.tab:hover \{/.test(css)

// Bentuk lama, persis seperti sebelum dibetulkan. Dipakai untuk membuktikan guard di atas
// benar-benar menggigit, bukan lulus karena polanya mustahil ditemukan.
const OLD_ACTIVE = `  background: color-mix(in srgb, var(--accent) 18%, transparent);
  color: var(--text);
  box-shadow: inset 0 -2px 0 var(--accent);
`
const OLD_HOVER_CSS = `
.tab:hover {
  background: rgba(var(--tint-rgb), 0.08);
  color: var(--text);
}
`

describe('penanda tab workspace terpilih', () => {
  it('`.tab--active` tidak lagi memakai fill atau bayangan permukaan', () => {
    // Dihitung dulu: aturan yang tidak ketemu memulangkan string kosong, dan guard apa pun di
    // atasnya akan menjawab tanpa menjaga apa pun.
    expect(hasNoSurfaceFill(rule(src('styles.css'), '.tab--active'))).toBe(true)
  })

  it('garis bawah dipindahkan ke dalam kotak tab, supaya tidak terpotong scroll container', () => {
    expect(underlineSitsInsideTab(src('styles.css'))).toBe(true)
  })

  it('teksnya tetap `--text`, bukan `--muted` seperti tab non-aktif', () => {
    expect(rule(src('styles.css'), '.tab--active')).toMatch(/color:\s*var\(--text\)/)
  })

  it('hover tidak menimpa penanda tab yang sedang aktif', () => {
    expect(hoverSparesActive(src('styles.css'))).toBe(true)
  })

  it('guard menolak bentuk lamanya', () => {
    expect(hasNoSurfaceFill(OLD_ACTIVE)).toBe(false)
    expect(hoverSparesActive(OLD_HOVER_CSS)).toBe(false)
    // Dan melewatkan bentuk yang benar, supaya bukan guard yang selalu merah.
    expect(hasNoSurfaceFill('  color: var(--text);\n')).toBe(true)
    expect(underlineSitsInsideTab(".tabbar__tabs [data-slot='tabs-trigger']::after {\n  bottom: -5px;\n}")).toBe(false)
  })
})

describe('dot status tetap miliknya sendiri', () => {
  it('keterpilihan tidak menyentuh `.tab__dot` — dua informasi berbeda, dua glyph berbeda', () => {
    const css = src('styles.css')
    expect(css).not.toMatch(/\.tab--active[^{]*\.tab__dot/)
    // Dot tetap dipetakan dari token status, bukan dari keterpilihan.
    for (const [state, token] of [
      ['idle', '--state-queued'],
      ['working', '--state-working'],
      ['attention', '--state-attention'],
    ]) {
      expect(css).toContain(`.tab__dot--${state} { background: var(${token}); }`)
    }
  })
})

describe('markup yang memasang penandanya', () => {
  it('strip memakai primitif Tabs: TabsList varian line + TabsTrigger asChild', () => {
    const bar = src('WorkspaceBar.tsx')
    expect(bar).toContain("from '@/components/ui/tabs'")
    expect(bar).toMatch(/<Tabs value=\{activeId \?\? ''\} onValueChange=\{onSelect\}/)
    expect(bar).toContain('variant="line"')
    // Atributnya multiline (ada komentar di antaranya), jadi bukan satu baris literal.
    expect(bar).toMatch(/<TabsTrigger[\s\S]{0,240}?asChild[\s\S]{0,80}?value=\{g\.projectId\}/)
    // Root Tabs merender satu wrapper; tanpa `contents` ia menjadi flex item di
    // `.tabbar__projects` dan tombol `+` terlempar ke baris lain.
    expect(bar).toContain('className="contents"')
  })

  it('peran/atribut tab tidak lagi dipasang tangan — Radix yang memilikinya', () => {
    const bar = src('WorkspaceBar.tsx')
    expect(bar).not.toContain('role="tablist"')
    expect(bar).not.toContain('role="tab"')
    expect(bar).not.toContain('aria-selected=')
    expect(bar).not.toContain('tabIndex=')
  })

  it('kelas `tab--active` tetap jadi kait, bukan sumber gaya', () => {
    expect(src('WorkspaceBar.tsx')).toContain("className={g.isActive ? 'tab tab--active' : 'tab'}")
  })

  it('kebab dan input memutus `mousedown`: Radix memilih tab pada mousedown trigger', () => {
    // `onClick` saja tidak cukup — aktivasi Radix terjadi di mousedown, yang tidak ikut berhenti.
    const bar = src('WorkspaceBar.tsx')
    expect(bar.match(/onMouseDown=\{\(e\) => e\.stopPropagation\(\)\}/g)).toHaveLength(2)
  })
})


// ---- Luapan strip tab: petunjuk bahwa deretannya berlanjut di luar layar ----
// Dengan 20 workspace strip menggulung, tapi scrollbar-nya disembunyikan dan tepinya terpotong
// rata, jadi tidak ada apa pun yang mengatakan ada tab lain. Perhitungan sisinya diuji di
// `workspaceTabs.test.ts`; yang dijaga di sini adalah bahwa CHROME-nya benar-benar terpasang —
// tanpa DOM tidak ada computed style yang bisa dibaca, jadi source-nya yang dibaca.

/** Selektor mana saja di `styles.css` yang memasang `mask-image` pada strip tab. */
const maskedStripSelectors = (css: string): string[] =>
  [...css.matchAll(/\n([^\n{]+)\{[^}]*mask-image:/g)]
    .map((m) => m[1])
    .filter((s) => s.includes('.tabbar__tabs'))

/**
 * Pudarnya harus PER SISI: tiga aturan, semuanya di bawah `[data-overflow=...]`. Masker yang
 * dipasang langsung di `.tabbar__tabs` memudarkan kedua tepi selamanya — termasuk saat tab terakhir
 * sudah tampak seluruhnya, yang menjanjikan tab yang tidak ada.
 */
const fadesOnlyTheSideThatHides = (css: string): boolean => {
  const sel = maskedStripSelectors(css)
  return sel.length === 3 && sel.every((s) => /\[data-overflow='(left|right|both)'\]/.test(s))
}

/** Roda boleh ditelan hanya kalau strip memang bisa bergerak, dan `preventDefault` butuh listener
 *  NON-passive — prop `onWheel` React tidak bisa memberikannya. */
const wheelIsConditionalAndNonPassive = (tsx: string): boolean =>
  /addEventListener\('wheel',[^)]*\{ passive: false \}\)/.test(tsx) &&
  /if \(!canScrollStripBy\(/.test(tsx) &&
  !/onWheel=/.test(tsx)

// Bentuk lama, persis seperti sebelum dibetulkan — buktinya guard di atas menggigit.
const OLD_ALWAYS_FADED_CSS = `
.tabbar__tabs {
  overflow-x: auto;
  mask-image: linear-gradient(to right, transparent, #000 24px, #000 calc(100% - 24px), transparent);
}
`
const OLD_WHEEL_TSX = `
  const onWheel = (e: React.WheelEvent) => { e.preventDefault(); strip.scrollLeft += e.deltaY }
  return <div onWheel={onWheel} />
`

describe('pudar tepi strip tab', () => {
  it('terpasang per sisi lewat `data-overflow`, tidak permanen di `.tabbar__tabs`', () => {
    expect(fadesOnlyTheSideThatHides(src('styles.css'))).toBe(true)
  })

  it('lebar pita pudar hidup di CSS sebagai `--tab-fade`, satu sumber angka', () => {
    // `WorkspaceBar.tsx` membacanya kembali; dua angka kembar akan menyimpang diam-diam.
    expect(rule(src('styles.css'), '.tabbar__tabs')).toMatch(/--tab-fade:\s*\d+px/)
    expect(src('WorkspaceBar.tsx')).toContain("getPropertyValue('--tab-fade')")
  })

  it('luapan dasarnya TIDAK dibongkar: strip tetap menggulung, bukan membungkus', () => {
    const body = rule(src('styles.css'), '.tabbar__tabs')
    expect(body).toMatch(/overflow-x:\s*auto/)
    expect(body).toMatch(/min-width:\s*0/)
    expect(body).not.toMatch(/flex-wrap/)
  })

  it('guard menolak bentuk lamanya', () => {
    expect(fadesOnlyTheSideThatHides(OLD_ALWAYS_FADED_CSS)).toBe(false)
    expect(wheelIsConditionalAndNonPassive(OLD_WHEEL_TSX)).toBe(false)
  })
})

describe('strip menyusul tab aktif dan roda mouse', () => {
  it('tab aktif digulung ke tampak setiap kali `activeId` berubah', () => {
    const bar = src('WorkspaceBar.tsx')
    expect(bar).toContain('revealActiveTab(strip)')
    expect(bar).toMatch(/\}, \[activeId, groups\.length\]\)/)
  })

  it('revealnya "sedekat mungkin", bukan `scrollIntoView` yang menyeret ancestor', () => {
    const bar = src('WorkspaceBar.tsx')
    expect(bar).toContain('scrollTopToReveal(')
    expect(bar).not.toContain('scrollIntoView')
  })

  it('roda vertikal diterjemahkan jadi horizontal, dan tidak ditelan kalau sia-sia', () => {
    expect(wheelIsConditionalAndNonPassive(src('WorkspaceBar.tsx'))).toBe(true)
  })

  it('`data-overflow` benar-benar sampai ke elemen strip', () => {
    expect(src('WorkspaceBar.tsx')).toContain('data-overflow={overflow}')
  })
})
