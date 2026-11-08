import { describe, it, expect } from 'vitest'
import { DEFAULT_SETTINGS, KEYBINDINGS_LIMITS, mergeSettings, normalizeKeybindings } from './settings'
import type { Settings } from './settings'

describe('DEFAULT_SETTINGS', () => {
  it('tidak memuat kunci yang bisa membawa rahasia (settings melintas HTTP)', () => {
    // `key$` bukan `key`: `terminalFontZoomKeys` adalah tombol keyboard, bukan kredensial.
    const risky = /secret|token|password|credential|auth|key$/i
    expect(Object.keys(DEFAULT_SETTINGS).filter((k) => risky.test(k))).toEqual([])
  })

  it('default scrollback dalam BYTE sama dengan konstanta server hari ini (256 KiB)', () => {
    expect(DEFAULT_SETTINGS.scrollbackBytes).toBe(256 * 1024)
  })

  it('zoom font via keyboard ON secara default, dan nilai tersimpan eksplisit tidak tertimpa', () => {
    expect(DEFAULT_SETTINGS.terminalFontZoomKeys).toBe(true)
    expect(mergeSettings({}).terminalFontZoomKeys).toBe(true)
    expect(mergeSettings({ terminalFontZoomKeys: false }).terminalFontZoomKeys).toBe(false)
  })

  it('terminalGpuRendering tidak menawarkan mode "shared" milik nodeterm', () => {
    expect(DEFAULT_SETTINGS.terminalGpuRendering).toBe('auto')
    // Pengaman tipe: nilai 'shared' tidak boleh assignable.
    // @ts-expect-error 'shared' bukan TerminalGpuRendering di webterm
    const _: Settings['terminalGpuRendering'] = 'shared'
    void _
  })
})

describe('mergeSettings', () => {
  it('mengisi setiap kunci yang absen dari default', () => {
    expect(mergeSettings({ fontSize: 18 })).toEqual({ ...DEFAULT_SETTINGS, fontSize: 18 })
  })

  it('TIDAK menjatuhkan kunci baru saat file lama hanya memuat sebagian', () => {
    // File dari versi sebelum `canvasDots`/`openMarkdownPreview` ada.
    const old = { fontSize: 15, accent: '#ff0000', gridSize: 32 }
    const merged = mergeSettings(old)
    expect(merged.canvasDots).toBe(DEFAULT_SETTINGS.canvasDots)
    expect(merged.openMarkdownPreview).toBe(DEFAULT_SETTINGS.openMarkdownPreview)
    expect(merged.hookReplyApprovals).toBe(DEFAULT_SETTINGS.hookReplyApprovals)
    expect(Object.keys(merged).sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort())
  })

  it('objek parsial pada kunci bernilai objek tidak menjatuhkan apa pun (defaultnya kosong)', () => {
    const merged = mergeSettings({ agentLaunchCommands: { claude: 'claude-wrapper' } })
    expect(merged.agentLaunchCommands).toEqual({ claude: 'claude-wrapper' })
  })

  it('settings normaliser drops non-Claude launch commands and retired ids from disabledAgents', () => {
    const merged = mergeSettings({
      agentLaunchCommands: { claude: 'claude-wrapper', codex: 'codex --profile x', gemini: 'gemini' },
      disabledAgents: ['codex', 'custom:a1', 'cursor', 'claude'],
    })
    expect(merged.agentLaunchCommands).toEqual({ claude: 'claude-wrapper' })
    expect(merged.disabledAgents).toEqual(['custom:a1', 'claude'])
    expect(mergeSettings({ agentLaunchCommands: { codex: 'codex' } }).agentLaunchCommands).toEqual({})
    expect(mergeSettings({ agentLaunchCommands: { claude: 7 } }).agentLaunchCommands).toEqual({})
  })

  it('mempertahankan nilai false dan 0 — bukan menganggapnya absen', () => {
    const merged = mergeSettings({
      cursorBlink: false,
      drawBoldTextInBrightColors: false,
      terminalLetterSpacing: 0,
    })
    expect(merged.cursorBlink).toBe(false)
    expect(merged.drawBoldTextInBrightColors).toBe(false)
    expect(merged.terminalLetterSpacing).toBe(0)
  })

  it('skipApprovals: absent (existing installs) -> true, stored false stays false, non-boolean ignored', () => {
    expect(mergeSettings({}).skipApprovals).toBe(true)
    expect(mergeSettings({ skipApprovals: false }).skipApprovals).toBe(false)
    expect(mergeSettings(JSON.parse(JSON.stringify(mergeSettings({ skipApprovals: false })))).skipApprovals).toBe(false)
    expect(mergeSettings({ skipApprovals: 'no' }).skipApprovals).toBe(true)
  })

  it('membuang nilai yang bentuknya tidak cocok dengan default (batas input HTTP)', () => {
    const merged = mergeSettings({
      fontSize: 'besar',
      cursorBlink: 'yes',
      customAgents: { nope: true },
      agentLaunchCommands: ['claude'],
      disabledAgents: 'claude',
      terminalTheme: null,
    })
    expect(merged.fontSize).toBe(DEFAULT_SETTINGS.fontSize)
    expect(merged.cursorBlink).toBe(DEFAULT_SETTINGS.cursorBlink)
    expect(merged.customAgents).toEqual([])
    expect(merged.agentLaunchCommands).toEqual({})
    expect(merged.disabledAgents).toEqual([])
    expect(merged.terminalTheme).toBe(DEFAULT_SETTINGS.terminalTheme)
  })

  it('membuang kunci tak dikenal, jadi sampah tidak menumpuk di store', () => {
    const merged = mergeSettings({ tmuxEnabled: true, notchWidth: 168, fontSize: 14 })
    expect('tmuxEnabled' in merged).toBe(false)
    expect('notchWidth' in merged).toBe(false)
    expect(merged.fontSize).toBe(14)
  })

  it('input yang bukan objek menghasilkan default apa adanya', () => {
    for (const bad of [null, undefined, 'x', 7, [], [{ fontSize: 99 }]]) {
      expect(mergeSettings(bad)).toEqual(DEFAULT_SETTINGS)
    }
  })

  it('tidak memutasi DEFAULT_SETTINGS', () => {
    const snapshot = JSON.stringify(DEFAULT_SETTINGS)
    const merged = mergeSettings({ fontSize: 99, customAgents: [{ id: 'custom:1', label: 'x', launchCmd: 'x' }] })
    merged.fontSize = 1
    expect(JSON.stringify(DEFAULT_SETTINGS)).toBe(snapshot)
  })
})

describe('keybindings', () => {
  it('defaults to no overrides and keeps valid id → chord | null entries', () => {
    expect(DEFAULT_SETTINGS.keybindings).toEqual({})
    expect(mergeSettings({ keybindings: { 'workbench.quickOpen': 'Mod+O', 'view.fit': null } }).keybindings)
      .toEqual({ 'workbench.quickOpen': 'Mod+O', 'view.fit': null })
  })

  it('drops malformed entries and bounds the map (input arrives over HTTP)', () => {
    const bad = { a: 7, b: '', c: { x: 1 }, ['x'.repeat(KEYBINDINGS_LIMITS.idLength + 1)]: 'Mod+K', d: 'M'.repeat(KEYBINDINGS_LIMITS.chordLength + 1), ok: 'Mod+J' }
    expect(mergeSettings({ keybindings: bad }).keybindings).toEqual({ ok: 'Mod+J' })
    expect(mergeSettings({ keybindings: ['Mod+K'] }).keybindings).toEqual({})
    const many = Object.fromEntries(Array.from({ length: KEYBINDINGS_LIMITS.entries + 50 }, (_, i) => [`c${i}`, 'Mod+K']))
    expect(Object.keys(normalizeKeybindings(many)).length).toBe(KEYBINDINGS_LIMITS.entries)
  })
})
