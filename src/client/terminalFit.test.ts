import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { fitGeometry } from './terminalFit'

const src = (f: string) => readFileSync(fileURLToPath(new URL(`./${f}`, import.meta.url)), 'utf8')

/**
 * Gejala: minimise (collapse) node agent lalu kembalikan ⇒ seluruh teks terminal hilang, dan tombol
 * refresh tak memulihkannya.
 *
 * Akar: node yang di-collapse hanya `display: none` (node-chrome.css), TIDAK di-unmount, jadi elemen
 * host xterm jadi 0×0 sementara `TerminalCore` tetap hidup. FitAddon menghitung cols/rows dari
 * dimensi nol itu dan `term.resize()` ke ukuran mikro ME-REFLOW buffer — reflow tak punya operasi
 * balikan, jadi scrollback-nya rusak permanen dan menggambar ulang tak bisa menolong.
 *
 * Tanpa DOM di vitest (`clientWidth`, `ResizeObserver` tak ada) yang bisa diuji adalah BENTUK
 * sumbernya: setiap call site `fit.fit()` harus bergerbang ukuran, dan hanya boleh ada SATU jalur
 * fit+resize sehingga gerbang itu tak bisa dilewati.
 */

const flat = (s: string) => s.replace(/\s+/g, ' ')

/** Gerbang harus menempel di call site-nya, bukan "ada di file ini entah di mana". */
const GATE_WINDOW = 80
// Both the old addon-fit call and today's `fitTerminal(term, el)` count as a fit call site.
const fitSites = (s: string) => flat(s).split(/fit\.fit\(\)|fitTerminal\(term, el\)/).slice(0, -1)
const ungatedFits = (s: string) =>
  fitSites(s).filter((before) => !before.slice(-GATE_WINDOW).includes('hasSize(el)')).length

// Bentuk LAMA, persis seperti di HEAD sebelum perbaikan. Dibawa sebagai konstanta supaya terbukti
// predikat di atas menggigit — bukan hijau karena polanya mustahil ditemukan.
const OLD_REFIT_FITS_WHILE_HIDDEN = `const refit = useCallback(() => {
    const term = termRef.current
    const fit = fitRef.current
    if (!term || !fit) return
    fit.fit()
    term.refresh(0, term.rows - 1)
    send({ t: 'resize', id, cols: term.cols, rows: term.rows })
  }, [id])`

const OLD_RO_FITS_WHILE_HIDDEN = `const ro = new ResizeObserver(() => {
      fit.fit()
      send({ t: 'resize', id, cols: term.cols, rows: term.rows })
    })`

const OLD_CREATE_FITS_WHILE_HIDDEN = `term.open(el)
    fit.fit()`

// Beda MATERIAL satu-satunya antara `refit` dan callback ResizeObserver yang lama: callback itu
// tidak pernah menggambar ulang. (Sisanya kosmetik — ia menutup `term`/`fit` lokal dari effect,
// objek yang sama persis dengan isi ref-nya.) Dedup menghapus asimetri itu.
const OLD_RO_SKIPS_REFRESH = true

const refitBody = (s: string) =>
  flat(s).match(/const refit = useCallback\(\(\) => \{(.*?)\}, \[id\]\)/)?.[1] ?? ''
const roPathRedraws = (s: string) =>
  flat(s).includes('coalesceFrames(refit)') && refitBody(s).includes('term.refresh(')

describe('gerbang fit TerminalCore', () => {
  it('predikatnya menggigit bentuk lama', () => {
    expect(ungatedFits(OLD_REFIT_FITS_WHILE_HIDDEN)).toBe(1)
    expect(ungatedFits(OLD_RO_FITS_WHILE_HIDDEN)).toBe(1)
    expect(ungatedFits(OLD_CREATE_FITS_WHILE_HIDDEN)).toBe(1)
    // Dan ia tidak menolak gerbang yang benar.
    expect(ungatedFits('if (hasSize(el)) fit.fit()')).toBe(0)
    // Gerbang yang jauh dari call site-nya TIDAK dihitung sebagai gerbang.
    expect(ungatedFits(`if (hasSize(el)) return\n${'x'.repeat(GATE_WINDOW)}\nfit.fit()`)).toBe(1)
  })

  it('tak ada satu pun `fit.fit()` yang bisa jalan saat elemen host 0×0', () => {
    const s = src('TerminalCore.tsx')
    // Dicek dulu bahwa masih ADA yang diukur — kalau tidak, nol di bawah hijau secara hampa.
    expect(fitSites(s).length).toBeGreaterThan(0)
    expect(ungatedFits(s)).toBe(0)
  })

  it('`hasSize` menuntut KEDUA dimensi, bukan salah satu', () => {
    // Node yang di-collapse bisa menyusut hanya pada tinggi; lebar nol saja juga sudah merusak.
    expect(flat(src('TerminalCore.tsx'))).toContain(
      'return el.clientWidth > 0 && el.clientHeight > 0',
    )
  })

  it('ResizeObserver memakai `refit`, jadi gerbangnya cuma satu dan tak ada jalur pintas', () => {
    const s = flat(src('TerminalCore.tsx'))
    expect(s).toContain('coalesceFrames(refit)')
    expect(s).toContain('new ResizeObserver(frames.schedule)')
    expect(s).not.toContain(flat(OLD_RO_FITS_WHILE_HIDDEN))
    expect(s).not.toContain(flat(OLD_REFIT_FITS_WHILE_HIDDEN))
  })

  it('jalur yang dipakai ResizeObserver ikut menggambar ulang, bukan sekadar mem-fit', () => {
    // Menyeret handle resize node HANYA melewati ResizeObserver. Setelah dedup, jalur itu sama
    // dengan `refit`, jadi ia ikut membawa `term.refresh`.
    expect(roPathRedraws(src('TerminalCore.tsx'))).toBe(true)
    expect(roPathRedraws(OLD_REFIT_FITS_WHILE_HIDDEN + OLD_RO_FITS_WHILE_HIDDEN)).toBe(
      !OLD_RO_SKIPS_REFRESH,
    )
  })

  it('gerbangnya tidak membunuh fitur: `refit` tetap fit, gambar ulang, dan kabari PTY', () => {
    const s = flat(src('TerminalCore.tsx'))
    expect(s).toContain('fitTerminal(term, el) term.refresh(0, term.rows - 1)')
    expect(s).toContain("send({ t: 'resize', id, ...next })")
  })
})

const NO_PAD = { top: 0, right: 0, bottom: 0, left: 0 }

/**
 * Symptom: Claude's prompt rule stopped ~2 columns short of the node's right edge.
 * Cause: addon-fit subtracts a 14 px scrollbar from the width, but xterm 6 draws an overlay
 * scrollbar that takes no layout width. `fitGeometry` counts every whole cell in the padded box.
 */
describe('fitGeometry', () => {
  const cell = { width: 8, height: 17 }

  it('uses the full width: no scrollbar reserve', () => {
    // 800 px / 8 px = 100 columns. addon-fit would give floor((800 - 14) / 8) = 98.
    expect(fitGeometry({ width: 800, height: 340, padding: NO_PAD, cell })).toEqual({ cols: 100, rows: 20 })
  })

  it('subtracts the element padding on both axes', () => {
    const padding = { top: 4, right: 4, bottom: 0, left: 8 }
    expect(fitGeometry({ width: 812, height: 344, padding, cell })).toEqual({ cols: 100, rows: 20 })
    // One px less than a whole cell drops it: the grid never overflows the box.
    expect(fitGeometry({ width: 811, height: 343, padding, cell })).toEqual({ cols: 99, rows: 19 })
  })

  it('a box that is an exact multiple of a fractional cell keeps its last column', () => {
    // (6.05 * 13) / 6.05 is 12.999999999999998 in floating point: a bare floor loses a column.
    const frac = { width: 6.05, height: 6.05 }
    expect(Math.floor((6.05 * 13) / 6.05)).toBe(12) // the noise is real, so the case below bites
    expect(fitGeometry({ width: 6.05 * 13, height: 6.05 * 13, padding: NO_PAD, cell: frac })).toEqual({ cols: 13, rows: 13 })
  })

  it('keeps addon-fit\'s minimum grid and refuses an unmeasured cell', () => {
    expect(fitGeometry({ width: 1, height: 1, padding: NO_PAD, cell })).toEqual({ cols: 2, rows: 1 })
    expect(fitGeometry({ width: 800, height: 340, padding: NO_PAD, cell: { width: 0, height: 17 } })).toBeUndefined()
  })
})

describe('terminal surface', () => {
  it('TerminalCore no longer fits through addon-fit, and paints the host with the theme background', () => {
    const s = src('TerminalCore.tsx')
    expect(s).not.toContain('@xterm/addon-fit')
    expect(s).not.toContain('fit.fit()')
    expect(flat(s)).toContain('style={{ background: resolveTerminalTheme(settings.terminalTheme).theme.background }}')
  })

  it('the xterm element fills the host, so no band shows under the last row', () => {
    const css = flat(src('terminal-surface.css'))
    expect(css).toMatch(/\.wt-term-host \.xterm \{[^}]*height: 100%/)
    expect(src('TerminalCore.tsx')).toContain("import './terminal-surface.css'")
  })
})
