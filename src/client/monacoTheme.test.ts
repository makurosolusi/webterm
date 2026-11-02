/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest'
import {
  currentMonacoTheme, defineWebtermThemes, EDITOR_OPTIONS, MONACO_THEME_DARK, MONACO_THEME_LIGHT,
} from './monacoTheme'

describe('monacoTheme', () => {
  it('mendaftarkan dua tema dengan latar Dark/Light Modern', () => {
    const defineTheme = vi.fn()
    defineWebtermThemes({ editor: { defineTheme } } as never)
    const byName = Object.fromEntries(defineTheme.mock.calls.map(([n, t]) => [n, t]))
    expect(byName[MONACO_THEME_DARK].base).toBe('vs-dark')
    expect(byName[MONACO_THEME_DARK].colors['editor.background']).toBe('#1F1F1F')
    expect(byName[MONACO_THEME_LIGHT].base).toBe('vs')
    expect(byName[MONACO_THEME_LIGHT].colors['editor.background']).toBe('#FFFFFF')
  })

  it('memilih tema dari data-theme di root', () => {
    const root = document.createElement('div')
    expect(currentMonacoTheme(root)).toBe(MONACO_THEME_DARK)
    root.setAttribute('data-theme', 'light')
    expect(currentMonacoTheme(root)).toBe(MONACO_THEME_LIGHT)
  })

  it('tidak memaksa tabSize atau smoothScrolling (default VS Code)', () => {
    expect(EDITOR_OPTIONS).not.toHaveProperty('tabSize')
    expect(EDITOR_OPTIONS).not.toHaveProperty('smoothScrolling')
  })
})
