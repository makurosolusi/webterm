import { describe, it, expect } from 'vitest'
import { DEFAULT_SETTINGS, mergeSettings } from './settings'
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

  it('mempertahankan nilai false dan 0 — bukan menganggapnya absen', () => {
    const merged = mergeSettings({
      cursorBlink: false,
      drawBoldTextInBrightColors: false,
      terminalLetterSpacing: 0,
      gridSize: 0,
    })
    expect(merged.cursorBlink).toBe(false)
    expect(merged.drawBoldTextInBrightColors).toBe(false)
    expect(merged.gridSize).toBe(0)
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
