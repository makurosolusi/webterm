import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../shared/settings'
import { DEFAULT_TERMINAL_THEME_ID, TERMINAL_THEMES, resolveTerminalTheme } from './themes'

const ANSI = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow',
  'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
] as const

/** WCAG relative luminance of a `#rrggbb` colour. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

describe('terminal theme catalogue', () => {
  it('the default theme id agrees with the settings default', () => {
    expect(DEFAULT_SETTINGS.terminalTheme).toBe(DEFAULT_TERMINAL_THEME_ID)
  })

  it('keeps every id a user may already have stored', () => {
    // Ids live in settings files; dropping one silently resets the user's choice.
    const stored = [
      'webterm-dark', 'webterm-light', 'dracula', 'tokyo-night', 'catppuccin-mocha',
      'catppuccin-latte', 'gruvbox-dark', 'nord', 'one-dark', 'solarized-dark', 'solarized-light',
    ]
    const ids = TERMINAL_THEMES.map((t) => t.id)
    for (const id of stored) expect(ids, id).toContain(id)
  })

  it('no theme id or label carries the legacy product name', () => {
    for (const t of TERMINAL_THEMES) {
      expect(t.id).not.toContain('legacy')
      expect(t.label.toLowerCase()).not.toContain('nodeterm')
    }
  })

  it('has unique ids and a complete, well-formed colour set per theme', () => {
    const ids = TERMINAL_THEMES.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const t of TERMINAL_THEMES) {
      expect(t.label).toBeTruthy()
      for (const key of ['background', 'foreground', 'cursor', 'cursorAccent', 'selectionBackground', ...ANSI] as const) {
        expect(t.theme[key], `${t.id}.${key}`).toMatch(/^#[0-9a-f]{6}([0-9a-f]{2})?$/)
      }
    }
  })

  it('offers both light and dark schemes and the flag matches the actual background', () => {
    expect(TERMINAL_THEMES.some((t) => t.dark)).toBe(true)
    expect(TERMINAL_THEMES.some((t) => !t.dark)).toBe(true)
    for (const t of TERMINAL_THEMES) {
      const isDarkBackground = luminance(t.theme.background!) < 0.18
      expect(t.dark, t.id).toBe(isDarkBackground)
    }
  })

  it('keeps body text readable: foreground over background is at least 4:1', () => {
    for (const t of TERMINAL_THEMES) {
      expect(contrast(t.theme.foreground!, t.theme.background!), t.id).toBeGreaterThanOrEqual(4)
    }
  })

  it('keeps the colourful ANSI slots distinguishable from the background', () => {
    // Black/white and their bright forms are skipped: schemes legitimately place them near the background.
    const hues = ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan'] as const
    for (const t of TERMINAL_THEMES) {
      for (const hue of hues) {
        const bright = `bright${hue[0].toUpperCase()}${hue.slice(1)}` as (typeof ANSI)[number]
        expect(contrast(t.theme[hue]!, t.theme.background!), `${t.id}.${hue}`).toBeGreaterThanOrEqual(2)
        expect(contrast(t.theme[bright]!, t.theme.background!), `${t.id}.${bright}`).toBeGreaterThanOrEqual(2)
      }
    }
  })

  it('the built-in pair follows the VS Code terminal defaults', () => {
    const dark = resolveTerminalTheme('webterm-dark').theme
    expect(dark.background).toBe('#1f1f1f')
    expect(dark.selectionBackground).toBe('#264f78')
    expect(dark.red).toBe('#cd3131')
    expect(dark.brightBlue).toBe('#3b8eea')
    const light = resolveTerminalTheme('webterm-light').theme
    expect(light.background).toBe('#ffffff')
    expect(light.cursor).toBe('#005fb8')
    expect(light.green).toBe('#107c10')
    expect(light.brightWhite).toBe('#a5a5a5')
  })

  it('the built-in pair carries scrollbar slider colours', () => {
    for (const id of ['webterm-dark', 'webterm-light']) {
      const { theme } = resolveTerminalTheme(id)
      expect(theme.scrollbarSliderBackground, id).toBeTruthy()
      expect(theme.scrollbarSliderHoverBackground, id).toBeTruthy()
      expect(theme.scrollbarSliderActiveBackground, id).toBeTruthy()
    }
  })

  it('expands a compact scheme so the cursor defaults to the foreground and the accent to the background', () => {
    const nord = resolveTerminalTheme('nord').theme
    expect(nord.cursor).toBe(nord.foreground)
    expect(nord.cursorAccent).toBe(nord.background)
    expect(resolveTerminalTheme('one-dark').theme.cursor).toBe('#528bff')
  })

  it('falls back to the default for unknown, empty and missing ids', () => {
    const fallback = resolveTerminalTheme(DEFAULT_TERMINAL_THEME_ID)
    expect(resolveTerminalTheme('removed-theme')).toBe(fallback)
    expect(resolveTerminalTheme('')).toBe(fallback)
    expect(resolveTerminalTheme(undefined)).toBe(fallback)
  })

  it('resolves the same id to the same object (live-option diffing relies on identity)', () => {
    expect(resolveTerminalTheme('nord')).toBe(resolveTerminalTheme('nord'))
    expect(resolveTerminalTheme('nord')).not.toBe(resolveTerminalTheme('dracula'))
  })
})
