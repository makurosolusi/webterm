import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Yang dijaga di sini adalah PENANDA tab workspace terpilih, yang hidup di aturan CSS
// `.tab--active` plus kelas/atribut yang memasangnya di `WorkspaceBar.tsx`. Vitest webterm jalan
// di node-env tanpa DOM, jadi tidak ada komponen yang bisa dirender dan tidak ada computed style
// yang bisa dibaca. Yang bisa dilakukan: membaca source-nya dan menolak bentuk yang salah — pola
// yang sama dengan `workspaceCommit.test.ts` dan `sidebarChrome.test.ts`.
//
// KENAPA ini perlu dijaga sama sekali: bentuk lamanya menandai tab aktif dengan fill permukaan
// (`var(--raised)` di atas bar `var(--panel)`), selisih 4 dari 255 yang tidak terlihat mata, jadi
// keterpilihan praktis bersandar pada kecerahan `.tab__dot` — yang membawa status agent, bukan
// keterpilihan. Regresi ke "fill permukaan" akan lolos review karena ia TERLIHAT benar di source.
const src = (f: string) => readFileSync(fileURLToPath(new URL(`./${f}`, import.meta.url)), 'utf8')

/** Badan satu aturan CSS, dari selektornya sampai `}` pertama. String kosong kalau tak ada. */
const rule = (css: string, selector: string): string => {
  const at = css.indexOf(`\n${selector} {`)
  return at === -1 ? '' : css.slice(at + selector.length + 3).split('}')[0]
}

/**
 * Penanda terpilih harus bersandar pada `--accent`, bukan pada permukaan: aksen mengubah hue, dan
 * hue terbaca tanpa membandingkan tab dengan tetangganya. `--raised`/`--panel`/`--bg` dilarang
 * eksplisit karena itulah justru bentuk lama yang gagal.
 */
const marksActiveWithAccent = (body: string) =>
  /background:[^;]*var\(--accent\)/.test(body) && !/background:\s*var\(--(raised|panel|bg|overlay)\)/.test(body)

/** Kanal BENTUK, supaya penandanya tidak bersandar pada warna saja: garis dasar 2px ber-aksen. */
const hasAccentBaseline = (body: string) => /inset 0 -2px 0 var\(--accent\)/.test(body)

/**
 * Tab aktif yang di-hover tetap terbaca aktif. `.tab:hover` punya spesifisitas lebih tinggi
 * daripada `.tab--active`, jadi aturan hover TANPA `:not()` menimpa penandanya justru saat
 * pointer ada di atasnya.
 */
const hoverSparesActive = (css: string) =>
  /\.tab:not\(\.tab--active\):hover \{/.test(css) && !/\n\.tab:hover \{/.test(css)

// Bentuk lama, persis seperti sebelum dibetulkan. Dipakai untuk membuktikan guard di atas
// benar-benar menggigit, bukan lulus karena polanya mustahil ditemukan.
const OLD_ACTIVE = `  background: var(--raised);
  color: var(--text);
  box-shadow: 0 1px 3px rgba(0, 0, 0, calc(0.3 * var(--shadow-k)));
`
const OLD_HOVER_CSS = `
.tab:hover {
  background: rgba(var(--tint-rgb), 0.08);
  color: var(--text);
}
`

describe('penanda tab workspace terpilih', () => {
  it('`.tab--active` ada dan menandai dengan aksen, bukan dengan fill permukaan', () => {
    // Dihitung dulu: aturan yang tidak ketemu memulangkan string kosong, dan guard apa pun di
    // atasnya akan menjawab tanpa menjaga apa pun.
    const body = rule(src('styles.css'), '.tab--active')
    expect(body.length).toBeGreaterThan(0)
    expect(marksActiveWithAccent(body)).toBe(true)
  })

  it('punya garis dasar ber-aksen — kanal bentuk di samping kanal warna', () => {
    expect(hasAccentBaseline(rule(src('styles.css'), '.tab--active'))).toBe(true)
  })

  it('teksnya tetap `--text`, bukan `--muted` seperti tab non-aktif', () => {
    expect(rule(src('styles.css'), '.tab--active')).toMatch(/color:\s*var\(--text\)/)
  })

  it('hover tidak menimpa penanda tab yang sedang aktif', () => {
    expect(hoverSparesActive(src('styles.css'))).toBe(true)
  })

  it('ketiga guard menolak bentuk lamanya', () => {
    expect(marksActiveWithAccent(OLD_ACTIVE)).toBe(false)
    expect(hasAccentBaseline(OLD_ACTIVE)).toBe(false)
    expect(hoverSparesActive(OLD_HOVER_CSS)).toBe(false)
    // Dan melewatkan bentuk yang benar, supaya bukan guard yang selalu merah.
    expect(marksActiveWithAccent('  background: color-mix(in srgb, var(--accent) 18%, transparent);')).toBe(true)
    expect(hasAccentBaseline('  box-shadow: inset 0 -2px 0 var(--accent);')).toBe(true)
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
  it('tab aktif membawa kelas `tab--active` DAN `aria-selected` — penanda non-visual', () => {
    const bar = src('WorkspaceBar.tsx')
    expect(bar).toContain('aria-selected={g.isActive}')
    expect(bar).toContain("className={g.isActive ? 'tab tab--active' : 'tab'}")
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
