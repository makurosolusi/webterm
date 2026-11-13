/** @vitest-environment jsdom */
// The Terminal › Look preview draws every look setting: colors, font, size, weights, bold-in-bright,
// line height, letter spacing, cursor shape and blink.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../shared/settings'
import { TerminalPreview } from './TerminalPreview'
import { resolveTerminalTheme } from './themes'

afterEach(cleanup)

const hex = (c: string): string => {
  const el = document.createElement('i')
  el.style.color = c
  return el.style.color // jsdom normalizes to rgb(...)
}

describe('TerminalPreview', () => {
  it('reflects colors, font, size, weights, line height and letter spacing', () => {
    const s = {
      ...DEFAULT_SETTINGS, terminalTheme: 'dracula', fontFamily: '"JetBrains Mono", monospace', fontSize: 17,
      fontWeight: 300, fontWeightBold: 600, terminalLineHeight: 1.4, terminalLetterSpacing: 2,
    }
    render(<TerminalPreview settings={s} />)
    const box = screen.getByTestId('terminal-preview')
    const t = resolveTerminalTheme('dracula').theme
    expect(box.style.background).toBe(hex(t.background!))
    expect(box.style.color).toBe(hex(t.foreground!))
    expect(box.style.fontFamily).toBe('"JetBrains Mono", monospace')
    expect(box.style.fontSize).toBe('17px')
    expect(box.style.fontWeight).toBe('300')
    expect(box.style.lineHeight).toBe('1.4')
    expect(box.style.letterSpacing).toBe('2px')
    expect(screen.getByTestId('terminal-preview-bold').style.fontWeight).toBe('600')
  })

  it('bold text uses the bright color only when "Draw bold text in bright colors" is on', () => {
    const t = resolveTerminalTheme(DEFAULT_SETTINGS.terminalTheme).theme
    render(<TerminalPreview settings={{ ...DEFAULT_SETTINGS, drawBoldTextInBrightColors: true }} />)
    expect(screen.getByTestId('terminal-preview-bold').style.color).toBe(hex(t.brightGreen!))
    cleanup()
    render(<TerminalPreview settings={{ ...DEFAULT_SETTINGS, drawBoldTextInBrightColors: false }} />)
    expect(screen.getByTestId('terminal-preview-bold').style.color).toBe(hex(t.green!))
  })

  it('draws the cursor in its style, blinking only when blink is on', () => {
    for (const style of ['block', 'bar', 'underline'] as const) {
      render(<TerminalPreview settings={{ ...DEFAULT_SETTINGS, cursorStyle: style, cursorBlink: false }} />)
      const cursor = screen.getByTestId('terminal-preview-cursor')
      expect(cursor.classList.contains(`st-tp-cursor--${style}`), style).toBe(true)
      expect(cursor.classList.contains('st-tp-cursor--blink')).toBe(false)
      cleanup()
    }
    render(<TerminalPreview settings={{ ...DEFAULT_SETTINGS, cursorBlink: true }} />)
    expect(screen.getByTestId('terminal-preview-cursor').classList.contains('st-tp-cursor--blink')).toBe(true)
  })

  it('the blink stops under prefers-reduced-motion', () => {
    const css = readFileSync(join(__dirname, 'settings-sections.css'), 'utf8')
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.st-tp-cursor--blink \{ animation: none; \}/)
  })
})
