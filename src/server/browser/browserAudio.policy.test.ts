// Locks the root of browser audio (docs/decisions/browser-audio.md): CDP names live only in the table, the injected script is
// network-free, the frame type is declared once, the server stays silent, and audio opens no window or tab.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FRAME_TYPE, FRAME_TYPE_AUDIO, FRAME_TYPE_TIMED } from '../../shared/browser.contract'
import { audioInjectSource } from './browser.audio.inject'
import { buildChromiumArgs } from './chromium.flags'

const BROWSER_DIR = __dirname
const SHARED_DIR = join(__dirname, '../../shared')
const AUDIO_SERVER_FILES = ['browserHost.audio.ts', 'browser.audio.inject.ts', 'browserWs.audio.ts']
const read = (dir: string, f: string) => readFileSync(join(dir, f), 'utf8')

describe('browser audio policy', () => {
  it('audio server code names no CDP method or event as a literal (only the table in cdp.client.ts does)', () => {
    const literal = /['"`](Runtime|Page|Target|Fetch|Emulation|Input|Browser)\.[A-Za-z]+['"`]/
    for (const f of AUDIO_SERVER_FILES) {
      const src = read(BROWSER_DIR, f)
      // the inject text is page JS, not CDP: it never contains such names either, so the same rule holds for it
      expect(literal.test(src), `${f} has a CDP literal`).toBe(false)
    }
  })

  it('the injected script has no network call and no eval', () => {
    const src = audioInjectSource()
    for (const banned of [/\bfetch\s*\(/, /XMLHttpRequest/, /\bWebSocket\b/, /sendBeacon/, /EventSource/, /\beval\s*\(/, /new\s+Function/, /\bimport\s*\(/, /importScripts/, /https?:\/\//, /document\.write/, /window\.open/]) {
      expect(banned.test(src), `inject source matches ${banned}`).toBe(false)
    }
  })

  it('the audio frame type is declared once in the contract and differs from the video types', () => {
    const declared = readdirSync(SHARED_DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && /\bFRAME_TYPE_AUDIO\s*=/.test(read(SHARED_DIR, f)))
    expect(declared).toEqual(['browser.contract.audio.ts'])
    expect(new Set([FRAME_TYPE, FRAME_TYPE_TIMED, FRAME_TYPE_AUDIO]).size).toBe(3)
    expect(FRAME_TYPE_AUDIO).toBe(3)
  })

  it('the server stays silent and sandboxed: --mute-audio always, never --no-sandbox, no autoplay override', () => {
    for (const headless of [false, true]) {
      const args = buildChromiumArgs({ profileDir: '/p', proxyServer: 'http://127.0.0.1:1', headless })
      expect(args).toContain('--mute-audio')
      expect(args.some((a) => a.includes('no-sandbox'))).toBe(false)
      expect(args.some((a) => a.includes('autoplay-policy'))).toBe(false)
    }
  })

  it('audio code opens no window or tab', () => {
    for (const f of AUDIO_SERVER_FILES) {
      const src = read(BROWSER_DIR, f)
      expect(/createTarget|newWindow|window\.open|surfac/i.test(src), `${f} could open a window`).toBe(false)
    }
  })
})
