import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, mergeSettings } from './settings'
import { clampSetting, SETTING_RANGES, type RangedKey } from './settings.ranges'

const KEYS = Object.keys(SETTING_RANGES) as RangedKey[]
const fallbackOf = (k: RangedKey): number => DEFAULT_SETTINGS[k]

describe('SETTING_RANGES', () => {
  it('setiap kunci number di DEFAULT_SETTINGS punya entri rentang (dan sebaliknya)', () => {
    const numeric = Object.entries(DEFAULT_SETTINGS)
      .filter(([, v]) => typeof v === 'number')
      .map(([k]) => k)
      .sort()
    expect([...KEYS].sort()).toEqual(numeric)
  })

  it('default tiap kunci berada di dalam rentangnya sendiri', () => {
    for (const k of KEYS) {
      const { min, max } = SETTING_RANGES[k]
      expect(min, k).toBeLessThan(max)
      expect(fallbackOf(k), k).toBeGreaterThanOrEqual(min)
      expect(fallbackOf(k), k).toBeLessThanOrEqual(max)
    }
  })

  it.each(KEYS)('%s: min-1, min, max, max+1, tak sah', (k) => {
    const { min, max } = SETTING_RANGES[k]
    const fb = fallbackOf(k)
    expect(clampSetting(k, min - 1, fb)).toBe(min)
    expect(clampSetting(k, min, fb)).toBe(min)
    expect(clampSetting(k, max, fb)).toBe(max)
    expect(clampSetting(k, max + 1, fb)).toBe(max)
    for (const bad of [NaN, Infinity, '', null, undefined, '12']) {
      expect(clampSetting(k, bad, fb)).toBe(fb)
    }
  })

  it('angka rentang yang dikunci kontrak (scrollbackBytes 16 KiB..64 MiB, grid 4..200)', () => {
    expect(SETTING_RANGES.scrollbackBytes).toMatchObject({ min: 16384, max: 67108864 })
    expect(SETTING_RANGES.gridSize).toMatchObject({ min: 4, max: 200 })
    expect(SETTING_RANGES.fontSize).toMatchObject({ min: 8, max: 32 })
  })
})

describe('mergeSettings memakai rentang', () => {
  it('menjepit nilai tersimpan di luar rentang', () => {
    const m = mergeSettings({ fontSize: 6, terminalLineHeight: 2.5, scrollbackBytes: 1, gridSize: 0 })
    expect(m.fontSize).toBe(8)
    expect(m.terminalLineHeight).toBe(2)
    expect(m.scrollbackBytes).toBe(16384)
    expect(m.gridSize).toBe(4)
    expect(mergeSettings({ fontSize: 40 }).fontSize).toBe(32)
  })

  it('NaN jadi default kunci itu; nilai sah lewat apa adanya', () => {
    expect(mergeSettings({ fontSize: NaN }).fontSize).toBe(DEFAULT_SETTINGS.fontSize)
    expect(mergeSettings({ fontSize: 'besar' }).fontSize).toBe(DEFAULT_SETTINGS.fontSize)
    expect(mergeSettings({ fontSize: 20 }).fontSize).toBe(20)
  })
})

// Rule 15: angka rentang hanya di settings.ranges.ts. Daftar berkas = pemilik WS-SA-01.
// Settings*.tsx (min/max UI) sengaja di luar daftar: milik WS UI yang memindahkannya ke tabel.
describe('tanpa literal rentang di luar settings.ranges.ts', () => {
  const root = join(__dirname, '..')
  const OWNED = [
    'client/terminalConfig.ts',
    'client/terminalKeys.ts',
    'client/App.canvas.tsx',
    'server/sessionsCore.ts',
    'server/ptyShell.ts',
    'shared/settings.ts',
  ]
  // Literal yang dulu menyebar: batas font zoom, clamp lokal, 16 KiB/64 MiB, scrollback lines.
  const FORBIDDEN = [/\b67108864\b/, /\b16384\b/, /64 \* 1024/, /16 \* 1024/, /\b100_?000\b/, /Math\.max\(4,/, /MAX = 28/, /MIN = 8\b/]

  it.each(OWNED)('%s', (f) => {
    const src = readFileSync(join(root, f), 'utf8')
    // Baris komentar boleh menyebut angka (penjelasan); yang dilarang adalah kodenya.
    const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
    for (const re of FORBIDDEN) expect(code, `${f} ${re}`).not.toMatch(re)
  })

  it('berkas milik masih ada (daftar tidak basi)', () => {
    for (const f of OWNED) expect(statSync(join(root, f)).isFile()).toBe(true)
    expect(readdirSync(join(root, 'shared'))).toContain('settings.ranges.ts')
  })
})
