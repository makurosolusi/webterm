// Theme "System" (setting value `auto`) follows the OS light/dark mode, not the terminal color scheme.
import { describe, expect, it } from 'vitest'
import { resolveAppTheme } from './App.hooks'

describe('resolveAppTheme', () => {
  it('System follows the OS; Light and Dark are fixed', () => {
    expect(resolveAppTheme('auto', true)).toBe('dark')
    expect(resolveAppTheme('auto', false)).toBe('light')
    expect(resolveAppTheme('light', true)).toBe('light')
    expect(resolveAppTheme('dark', false)).toBe('dark')
  })
})
