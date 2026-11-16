import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../shared/settings'
import {
  TERMINAL_LETTER_SPACING_MAX,
  TERMINAL_LETTER_SPACING_MIN,
  TERMINAL_LINE_HEIGHT_MAX,
  TERMINAL_LINE_HEIGHT_MIN,
  TERMINAL_SCROLLBACK_LINES_MAX,
  TERMINAL_SCROLLBACK_LINES_MIN,
  applyLiveOptions,
  terminalFontSize,
  terminalFontWeight,
  terminalLetterSpacing,
  terminalLineHeight,
  terminalMinContrast,
  xtermOptionsFromSettings,
  type LiveOptionTarget,
  type XtermVisualSettings,
} from './terminalConfig'
import { resolveTerminalTheme } from './themes'

const defaults: XtermVisualSettings = DEFAULT_SETTINGS

describe('value clamps', () => {
  it('passes in-range values through unchanged', () => {
    expect(terminalLineHeight(1.25)).toBe(1.25)
    expect(terminalLetterSpacing(2)).toBe(2)
    expect(terminalFontWeight(600, 400)).toBe(600)
    expect(terminalMinContrast(7)).toBe(7)
  })

  it('pins out-of-range values to the nearest bound', () => {
    expect(terminalLineHeight(-3)).toBe(TERMINAL_LINE_HEIGHT_MIN)
    expect(terminalLineHeight(1000)).toBe(TERMINAL_LINE_HEIGHT_MAX)
    expect(terminalLetterSpacing(-400)).toBe(TERMINAL_LETTER_SPACING_MIN)
    expect(terminalLetterSpacing(400)).toBe(TERMINAL_LETTER_SPACING_MAX)
    expect(terminalFontWeight(1, 400)).toBe(100)
    expect(terminalFontWeight(12_000, 400)).toBe(900)
    expect(terminalMinContrast(-1)).toBe(1)
    expect(terminalMinContrast(500)).toBe(21)
  })

  it('replaces NaN, Infinity and strings with the fallback so xterm never sees them', () => {
    expect(terminalLineHeight(Number.NaN)).toBe(DEFAULT_SETTINGS.terminalLineHeight)
    expect(terminalLetterSpacing(Number.NaN)).toBe(DEFAULT_SETTINGS.terminalLetterSpacing)
    expect(terminalMinContrast(Number.POSITIVE_INFINITY)).toBe(DEFAULT_SETTINGS.terminalMinContrast)
    expect(terminalFontWeight(Number.NaN, 700)).toBe(700)
    expect(terminalLineHeight('2' as unknown as number)).toBe(DEFAULT_SETTINGS.terminalLineHeight)
  })

  it('clamps the font size and rejects blank input', () => {
    expect(terminalFontSize(3)).toBe(8)
    expect(terminalFontSize(200)).toBe(32)
    expect(terminalFontSize(Number.NaN)).toBe(DEFAULT_SETTINGS.fontSize)
    expect(terminalFontSize('' as unknown as number)).toBe(DEFAULT_SETTINGS.fontSize)
  })
})

describe('xtermOptionsFromSettings', () => {
  it('maps each visual setting to its xterm option', () => {
    const custom: XtermVisualSettings = {
      ...defaults,
      fontFamily: 'Fira Code, monospace',
      fontSize: 15,
      fontWeight: 300,
      fontWeightBold: 800,
      drawBoldTextInBrightColors: false,
      terminalMinContrast: 4.5,
      terminalWordSeparator: ' /',
      cursorStyle: 'underline',
      cursorBlink: false,
      terminalLineHeight: 1.2,
      terminalLetterSpacing: 1,
      terminalTheme: 'dracula',
    }
    expect(xtermOptionsFromSettings(custom)).toMatchObject({
      fontFamily: 'Fira Code, monospace',
      fontSize: 15,
      fontWeight: 300,
      fontWeightBold: 800,
      drawBoldTextInBrightColors: false,
      minimumContrastRatio: 4.5,
      wordSeparator: ' /',
      cursorStyle: 'underline',
      cursorBlink: false,
      lineHeight: 1.2,
      letterSpacing: 1,
      theme: resolveTerminalTheme('dracula').theme,
    })
  })

  it('always shows an outlined cursor in unfocused terminals', () => {
    expect(xtermOptionsFromSettings(defaults).cursorInactiveStyle).toBe('outline')
  })

  it('always enables the proposed API (Unicode registration) and Option-drag selection', () => {
    const o = xtermOptionsFromSettings(defaults)
    expect(o.allowProposedApi).toBe(true)
    expect(o.macOptionClickForcesSelection).toBe(true)
  })

  it('takes scrollback from the line-count setting and ignores the server byte budget', () => {
    expect(DEFAULT_SETTINGS.scrollbackLines).not.toBe(DEFAULT_SETTINGS.scrollbackBytes)
    expect(xtermOptionsFromSettings({ ...defaults, scrollbackLines: 2500 }).scrollback).toBe(2500)
    const tinyBuffer = { ...DEFAULT_SETTINGS, scrollbackBytes: 512 }
    expect(xtermOptionsFromSettings(tinyBuffer).scrollback).toBe(DEFAULT_SETTINGS.scrollbackLines)
  })

  it('clamps scrollback to the allowed range and repairs NaN', () => {
    expect(xtermOptionsFromSettings({ ...defaults, scrollbackLines: 0 }).scrollback).toBe(
      TERMINAL_SCROLLBACK_LINES_MIN,
    )
    expect(xtermOptionsFromSettings({ ...defaults, scrollbackLines: 5e9 }).scrollback).toBe(
      TERMINAL_SCROLLBACK_LINES_MAX,
    )
    expect(xtermOptionsFromSettings({ ...defaults, scrollbackLines: Number.NaN }).scrollback).toBe(
      DEFAULT_SETTINGS.scrollbackLines,
    )
  })

  it('layers the per-terminal font size over the global one, and clamps it', () => {
    expect(xtermOptionsFromSettings(defaults, 22).fontSize).toBe(22)
    expect(xtermOptionsFromSettings(defaults).fontSize).toBe(defaults.fontSize)
    expect(xtermOptionsFromSettings(defaults, 500).fontSize).toBe(32)
    expect(xtermOptionsFromSettings({ ...defaults, fontSize: Number.NaN }).fontSize).toBe(
      DEFAULT_SETTINGS.fontSize,
    )
  })

  it('clamps several hand-edited values in one pass', () => {
    const o = xtermOptionsFromSettings({
      ...defaults,
      terminalLineHeight: 50,
      terminalLetterSpacing: -50,
      fontWeight: 70_000,
      terminalMinContrast: -5,
    })
    expect(o.lineHeight).toBe(TERMINAL_LINE_HEIGHT_MAX)
    expect(o.letterSpacing).toBe(TERMINAL_LETTER_SPACING_MIN)
    expect(o.fontWeight).toBe(900)
    expect(o.minimumContrastRatio).toBe(1)
  })

  it('uses the default theme when the stored id is unknown', () => {
    const o = xtermOptionsFromSettings({ ...defaults, terminalTheme: 'gone' })
    expect(o.theme).toBe(resolveTerminalTheme(undefined).theme)
  })
})

/** A stand-in terminal whose `options` records every write, so comparison guards are observable. */
function recordingTerminal(s: XtermVisualSettings, fontSizeOverride?: number) {
  const writes: string[] = []
  const state = { ...xtermOptionsFromSettings(s, fontSizeOverride) } as Record<string, unknown>
  const options = new Proxy(
    {},
    {
      get: (_t, key: string) => state[key],
      set: (_t, key: string, value) => {
        writes.push(key)
        state[key] = value
        return true
      },
    },
  )
  return { term: { options } as LiveOptionTarget, writes }
}

describe('applyLiveOptions', () => {
  it('writes nothing and reports nothing when settings did not change', () => {
    const { term, writes } = recordingTerminal(defaults)
    expect(applyLiveOptions(term, defaults)).toEqual({ metricsChanged: false, themeChanged: false })
    expect(writes).toEqual([])
  })

  it('writes only the options that differ', () => {
    const { term, writes } = recordingTerminal(defaults)
    applyLiveOptions(term, { ...defaults, cursorBlink: !defaults.cursorBlink })
    expect(writes).toEqual(['cursorBlink'])
  })

  it.each([
    ['font size', { fontSize: 19 }],
    ['font family', { fontFamily: 'Menlo, monospace' }],
    ['line height', { terminalLineHeight: 1.6 }],
    ['letter spacing', { terminalLetterSpacing: 2 }],
  ] as [string, Partial<XtermVisualSettings>][])('flags a %s change as a geometry change', (_name, patch) => {
    const { term } = recordingTerminal(defaults)
    expect(applyLiveOptions(term, { ...defaults, ...patch }).metricsChanged).toBe(true)
  })

  it('does not count a font-weight change as geometry', () => {
    const { term, writes } = recordingTerminal(defaults)
    const effects = applyLiveOptions(term, { ...defaults, fontWeight: 200, fontWeightBold: 900 })
    expect(effects.metricsChanged).toBe(false)
    expect(writes).toEqual(['fontWeight', 'fontWeightBold'])
  })

  it('treats a per-terminal zoom change as geometry', () => {
    const { term } = recordingTerminal(defaults)
    expect(applyLiveOptions(term, defaults, 24).metricsChanged).toBe(true)
  })

  it('swaps the theme only when the id changes', () => {
    const changed = recordingTerminal(defaults)
    const effects = applyLiveOptions(changed.term, { ...defaults, terminalTheme: 'one-dark' })
    expect(effects.themeChanged).toBe(true)
    expect(changed.writes).toEqual(['theme'])

    const same = recordingTerminal(defaults)
    expect(applyLiveOptions(same.term, { ...defaults }).themeChanged).toBe(false)
    expect(same.writes).toEqual([])
  })
})

// Source-level guards on the settings -> terminal wiring. `TerminalCore` once received its settings
// as an optional prop that no call site passed, so every Settings control silently did nothing.
// Components can't be rendered in the node-env runner, so the property is checked on the source:
// where settings come from, and which effect may react to them.
const readSrc = (file: string) =>
  readFileSync(fileURLToPath(new URL(`./${file}`, import.meta.url)), 'utf8')
const core = readSrc('TerminalCore.tsx')
/** Dependency arrays that close an effect: `}, [...])`. */
const dependencyLists = (code: string): string[] =>
  [...code.matchAll(/\}, (\[[^\]]*\])\)/g)].map((m) => m[1])

describe('settings to terminal wiring', () => {
  it('reads settings from the live-settings context, never from a prop or node data', () => {
    expect(core).toContain('useLiveSettings()')
    expect(core).not.toMatch(/settings\?: Settings/)
    expect(readSrc('App.tsx')).not.toMatch(/\.\.\.n\.data, settings/)
  })

  it('reacts to settings without recreating the terminal', () => {
    // The creation effect depends on `[id]` only; adding settings would drop scrollback on every
    // slider tick. The effect after it is the one that must react to settings.
    const creation = core.slice(core.indexOf('new Terminal('), core.indexOf('applyLiveOptions(term'))
    expect(dependencyLists(creation).at(-1)).toBe('[id]')
    expect(dependencyLists(core.slice(core.indexOf('applyLiveOptions(term')))[0]).toContain('settings')
  })
})
