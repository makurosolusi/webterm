import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../shared/settings'
import {
  DEFAULT_TERMINAL_THEME_ID,
  TERMINAL_THEMES,
  resolveTerminalTheme,
} from './themes'

describe('terminal themes', () => {
  it('default theme id matches the settings default', () => {
    // Kalau dua konstanta ini menyimpang, setiap terminal mendarat di tema fallback dan dropdown
    // settings menunjuk entri yang tidak dipakai siapa pun.
    expect(DEFAULT_SETTINGS.terminalTheme).toBe(DEFAULT_TERMINAL_THEME_ID)
  })

  it('no theme id leaks the nodeterm name', () => {
    // Id tema adalah permukaan TERLIHAT (dropdown settings) — beda dari wire-protocol nodeterm.
    for (const t of TERMINAL_THEMES) expect(t.id).not.toContain('nodeterm')
  })

  it('ids are unique and every theme is fully populated', () => {
    const ids = TERMINAL_THEMES.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const t of TERMINAL_THEMES) {
      expect(t.label).toBeTruthy()
      expect(typeof t.dark).toBe('boolean')
      // Palet 16 warna ANSI + background/foreground/cursor/cursorAccent/selectionBackground.
      // Lubang mana pun dan xterm diam-diam memakai warna built-in-nya di tengah skema lain.
      for (const key of [
        'background',
        'foreground',
        'cursor',
        'cursorAccent',
        'selectionBackground',
        'black',
        'red',
        'green',
        'yellow',
        'blue',
        'magenta',
        'cyan',
        'white',
        'brightBlack',
        'brightRed',
        'brightGreen',
        'brightYellow',
        'brightBlue',
        'brightMagenta',
        'brightCyan',
        'brightWhite',
      ] as const) {
        expect(t.theme[key], `${t.id}.${key}`).toMatch(/^#[0-9a-f]{6}([0-9a-f]{2})?$/)
      }
    }
  })

  it('has both dark and light schemes, and flags them correctly', () => {
    // Chrome node mengikuti flag ini (appTheme 'auto'), jadi flag yang salah meninggalkan rangka
    // hitam di sekitar terminal krem.
    expect(TERMINAL_THEMES.some((t) => t.dark)).toBe(true)
    expect(TERMINAL_THEMES.some((t) => !t.dark)).toBe(true)
    const byId = new Map(TERMINAL_THEMES.map((t) => [t.id, t]))
    expect(byId.get('webterm-dark')?.dark).toBe(true)
    expect(byId.get('webterm-light')?.dark).toBe(false)
    expect(byId.get('solarized-light')?.dark).toBe(false)
  })

  it('webterm-dark keeps the colours TerminalCore rendered before themes existed', () => {
    // Dipaku dengan sengaja: "memperbaiki" nilai-nilai ini diam-diam mengecat ulang terminal
    // setiap pengguna yang sudah ada. background/foreground dari literal lama TerminalCore,
    // sisanya palet built-in xterm (Tango) yang dulu terisi implisit.
    const { theme } = resolveTerminalTheme('webterm-dark')
    expect(theme.background).toBe('#1e1e1e')
    expect(theme.red).toBe('#cc0000')
    expect(theme.brightBlue).toBe('#729fcf')
    expect(theme.brightWhite).toBe('#eeeeec')
  })

  it('resolves unknown, empty and missing ids to the default instead of throwing', () => {
    // Nilai settings bisa diedit tangan dan melintas antar versi; tema `undefined` ke xterm =
    // terminal jatuh ke latar hitamnya sendiri, app tampak rusak karena satu kata.
    const fallback = resolveTerminalTheme(DEFAULT_TERMINAL_THEME_ID)
    expect(resolveTerminalTheme('tema-yang-dihapus')).toBe(fallback)
    expect(resolveTerminalTheme('')).toBe(fallback)
    expect(resolveTerminalTheme(undefined)).toBe(fallback)
    expect(resolveTerminalTheme('nodeterm-dark')).toBe(fallback)
  })

  it('returns an identical object for the same id', () => {
    // `applyLiveOptions` mendeteksi perubahan tema lewat IDENTITAS (`!==`); resolver yang
    // mengembalikan salinan baru membuat setiap re-option membangun ulang palet.
    expect(resolveTerminalTheme('nord')).toBe(resolveTerminalTheme('nord'))
    expect(resolveTerminalTheme('nord')).not.toBe(resolveTerminalTheme('dracula'))
  })
})
