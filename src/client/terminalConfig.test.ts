import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, type Settings } from '../shared/settings'
import {
  TERMINAL_LETTER_SPACING_MAX,
  TERMINAL_LETTER_SPACING_MIN,
  TERMINAL_LINE_HEIGHT_MAX,
  TERMINAL_LINE_HEIGHT_MIN,
  TERMINAL_SCROLLBACK_LINES_MAX,
  TERMINAL_SCROLLBACK_LINES_MIN,
  applyLiveOptions,
  terminalFontWeight,
  terminalLetterSpacing,
  terminalLineHeight,
  terminalMinContrast,
  xtermOptionsFromSettings,
  type LiveOptionTarget,
  type XtermVisualSettings,
} from './terminalConfig'
import { resolveTerminalTheme } from './themes'

const base: XtermVisualSettings = DEFAULT_SETTINGS

describe('clamps', () => {
  it('keeps in-range values untouched', () => {
    expect(terminalLineHeight(1.4)).toBe(1.4)
    expect(terminalLetterSpacing(-1)).toBe(-1)
    expect(terminalFontWeight(500, 400)).toBe(500)
    expect(terminalMinContrast(4.5)).toBe(4.5)
  })

  it('clamps out-of-range values to the bounds', () => {
    expect(terminalLineHeight(0)).toBe(TERMINAL_LINE_HEIGHT_MIN)
    expect(terminalLineHeight(99)).toBe(TERMINAL_LINE_HEIGHT_MAX)
    expect(terminalLetterSpacing(-50)).toBe(TERMINAL_LETTER_SPACING_MIN)
    expect(terminalLetterSpacing(50)).toBe(TERMINAL_LETTER_SPACING_MAX)
    expect(terminalFontWeight(0, 400)).toBe(100)
    expect(terminalFontWeight(5000, 400)).toBe(900)
    expect(terminalMinContrast(0)).toBe(1)
    expect(terminalMinContrast(100)).toBe(21)
  })

  it('sends NaN and non-numbers to the fallback, never through to xterm', () => {
    // Settings bisa diedit tangan dan datang lewat HTTP. xterm menerima NaN dengan senang hati
    // lalu merender grid bertinggi nol — tidak ada error, cuma terminal kosong.
    expect(terminalLineHeight(NaN)).toBe(1)
    expect(terminalLetterSpacing(NaN)).toBe(0)
    expect(terminalMinContrast(Infinity)).toBe(1)
    expect(terminalFontWeight(NaN, 700)).toBe(700)
    expect(terminalLineHeight('1.5' as unknown as number)).toBe(1)
  })
})

describe('xtermOptionsFromSettings', () => {
  it('maps every appearance key from settings', () => {
    const o = xtermOptionsFromSettings(base)
    expect(o.fontFamily).toBe(base.fontFamily)
    expect(o.fontSize).toBe(base.fontSize)
    expect(o.wordSeparator).toBe(base.terminalWordSeparator)
    expect(o.fontWeight).toBe(400)
    expect(o.fontWeightBold).toBe(700)
    expect(o.drawBoldTextInBrightColors).toBe(true)
    expect(o.minimumContrastRatio).toBe(1)
    expect(o.cursorBlink).toBe(true)
    expect(o.cursorStyle).toBe('block')
    expect(o.cursorInactiveStyle).toBe('outline')
    expect(o.lineHeight).toBe(1)
    expect(o.letterSpacing).toBe(0)
    expect(o.theme).toBe(resolveTerminalTheme(base.terminalTheme).theme)
  })

  it('always asks for the proposed API, which Unicode 11 registration needs', () => {
    expect(xtermOptionsFromSettings(base).allowProposedApi).toBe(true)
    expect(xtermOptionsFromSettings(base).macOptionClickForcesSelection).toBe(true)
  })

  it('sets scrollback from scrollbackLines, never from scrollbackBytes', () => {
    // `settings.scrollbackBytes` membatasi ring buffer BYTE di server. Memakainya di sini akan
    // memberi xterm 262.144 BARIS buffer per node.
    expect(xtermOptionsFromSettings(base).scrollback).toBe(DEFAULT_SETTINGS.scrollbackLines)
    expect(DEFAULT_SETTINGS.scrollbackLines).not.toBe(DEFAULT_SETTINGS.scrollbackBytes)
    // Nilai non-default ikut terbawa, dan mengubah kunci BYTE tidak menggeser scrollback xterm.
    expect(xtermOptionsFromSettings({ ...base, scrollbackLines: 4_000 }).scrollback).toBe(4_000)
    const tinyServerBuffer: Settings = { ...DEFAULT_SETTINGS, scrollbackBytes: 1024 }
    expect(xtermOptionsFromSettings(tinyServerBuffer).scrollback).toBe(
      DEFAULT_SETTINGS.scrollbackLines,
    )
  })

  it('clamps a hand-edited scrollbackLines instead of handing xterm a useless buffer', () => {
    expect(xtermOptionsFromSettings({ ...base, scrollbackLines: 1 }).scrollback).toBe(
      TERMINAL_SCROLLBACK_LINES_MIN,
    )
    expect(xtermOptionsFromSettings({ ...base, scrollbackLines: 10_000_000 }).scrollback).toBe(
      TERMINAL_SCROLLBACK_LINES_MAX,
    )
    expect(xtermOptionsFromSettings({ ...base, scrollbackLines: NaN }).scrollback).toBe(
      DEFAULT_SETTINGS.scrollbackLines,
    )
  })

  it('layers the per-terminal font size override over the global size', () => {
    expect(xtermOptionsFromSettings(base, 20).fontSize).toBe(20)
    expect(xtermOptionsFromSettings(base, undefined).fontSize).toBe(base.fontSize)
  })

  it('clamps hand-edited settings on the way in', () => {
    const o = xtermOptionsFromSettings({
      ...base,
      terminalLineHeight: 9,
      terminalLetterSpacing: -9,
      fontWeight: 9999,
      terminalMinContrast: 0,
    })
    expect(o.lineHeight).toBe(TERMINAL_LINE_HEIGHT_MAX)
    expect(o.letterSpacing).toBe(TERMINAL_LETTER_SPACING_MIN)
    expect(o.fontWeight).toBe(900)
    expect(o.minimumContrastRatio).toBe(1)
  })

  it('falls back to the default theme for an unknown id', () => {
    expect(xtermOptionsFromSettings({ ...base, terminalTheme: 'nope' }).theme).toBe(
      resolveTerminalTheme(undefined).theme,
    )
  })
})

/** Terminal tiruan yang mencatat setiap PENULISAN, supaya guard perbandingan bisa diperiksa. */
function fakeTerm(s: XtermVisualSettings, fontSizeOverride?: number) {
  const written: string[] = []
  const values = { ...xtermOptionsFromSettings(s, fontSizeOverride) } as Record<string, unknown>
  const options = new Proxy(
    {},
    {
      get: (_t, k: string) => values[k],
      set: (_t, k: string, v) => {
        written.push(k)
        values[k] = v
        return true
      },
    },
  )
  return { term: { options } as LiveOptionTarget, written }
}

describe('applyLiveOptions', () => {
  it('writes nothing when settings are unchanged', () => {
    // `options` xterm adalah proxy setter: menulis nilai yang tidak berubah tetap memicu
    // penanganan perubahan, dan setiap ketikan di settings me-re-option SETIAP terminal.
    const { term, written } = fakeTerm(base)
    expect(applyLiveOptions(term, base)).toEqual({ metricsChanged: false, themeChanged: false })
    expect(written).toEqual([])
  })

  it('writes only the options that actually changed', () => {
    const { term, written } = fakeTerm(base)
    applyLiveOptions(term, { ...base, cursorStyle: 'bar' })
    expect(written).toEqual(['cursorStyle'])
  })

  it('reports metricsChanged for cell geometry only', () => {
    for (const patch of [
      { fontSize: 18 },
      { fontFamily: 'monospace' },
      { terminalLineHeight: 1.5 },
      { terminalLetterSpacing: 1 },
    ] as Partial<XtermVisualSettings>[]) {
      const { term } = fakeTerm(base)
      expect(applyLiveOptions(term, { ...base, ...patch }).metricsChanged, String(patch)).toBe(true)
    }
  })

  it('does not treat font weights as a geometry change', () => {
    // Ukuran sel xterm datang dari CharSizeService, yang hanya mengukur ulang pada
    // fontFamily/fontSize — refit karena bobot hanya melaporkan resize sia-sia ke PTY.
    const { term, written } = fakeTerm(base)
    const effects = applyLiveOptions(term, { ...base, fontWeight: 300, fontWeightBold: 600 })
    expect(effects.metricsChanged).toBe(false)
    expect(written).toEqual(['fontWeight', 'fontWeightBold'])
  })

  it('treats a font size override change as a geometry change', () => {
    // ⌘+ harus memicu refit yang sama dengan mengubah fontSize global.
    const { term } = fakeTerm(base)
    expect(applyLiveOptions(term, base, 20).metricsChanged).toBe(true)
  })

  it('reports and writes the theme only when the id changes', () => {
    const { term, written } = fakeTerm(base)
    const effects = applyLiveOptions(term, { ...base, terminalTheme: 'nord' })
    expect(effects.themeChanged).toBe(true)
    expect(written).toEqual(['theme'])

    const same = fakeTerm(base)
    expect(applyLiveOptions(same.term, { ...base, terminalTheme: base.terminalTheme }).themeChanged)
      .toBe(false)
  })
})

// Fungsi di atas benar tapi pernah MATI: `TerminalCore` menerima settings sebagai prop, dan tak
// satu pun dari kedua call site-nya (`TerminalNode`, `AgentNode`) mengirimnya — jadi tiap kontrol
// di panel Settings tidak berpengaruh ke terminal yang hidup. Regresi sunyi: tak ada yang pecah.
// Vitest di sini node-env tanpa DOM, komponen tak bisa dirender, jadi jalurnya dijaga sebagai
// teks. Yang dijaga adalah SIFATNYA, bukan ejaan barisnya: siapa sumber settings, dan effect mana
// yang boleh bereaksi padanya.
const src = (f: string) => readFileSync(fileURLToPath(new URL(`./${f}`, import.meta.url)), 'utf8')
const core = src('TerminalCore.tsx')
/** Deps array yang menutup `}, [...])`. */
const deps = (s: string): string[] => [...s.matchAll(/\}, (\[[^\]]*\])\)/g)].map((m) => m[1])

describe('jalur settings → xterm', () => {
  it('mengambil settings dari context, bukan dari prop atau data node', () => {
    expect(core).toContain('useLiveSettings()')
    // Prop opsional yang tak pernah dikirim = default senyap. Itu bug-nya; jangan kembali.
    expect(core).not.toMatch(/settings\?: Settings/)
    // Dan App tidak lagi menyuntikkannya ke `data` setiap node (identitas data baru tiap drag).
    expect(src('App.tsx')).not.toMatch(/\.\.\.n\.data, settings/)
  })

  it('bereaksi ke settings TANPA membuat ulang terminal', () => {
    // Effect pembuatan ber-deps `[id]` SAJA: menambahkan settings ke sana membuang scrollback
    // setiap kali slider digeser. Deps terakhir sebelum `applyLiveOptions` adalah milik effect itu.
    const creation = core.slice(core.indexOf('new Terminal('), core.indexOf('applyLiveOptions(term'))
    expect(deps(creation).at(-1)).toBe('[id]')
    // Sebaliknya effect penerap HARUS bereaksi — di sinilah settings menyentuh terminal hidup.
    expect(deps(core.slice(core.indexOf('applyLiveOptions(term')))[0]).toContain('settings')
  })
})
