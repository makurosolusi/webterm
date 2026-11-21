/** @vitest-environment jsdom */
// Settings > Browser > Sound: switch default on (from the registry entry), save on/off, Reset, rollback, locked states, search entry.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ENV_BROWSER } from '../shared/browser.contract'
import { AUDIO_DEFAULT_TEXT, BrowserAudioDefaultField } from './BrowserAudioDefaultField'
import { resetBrowserStatusCache } from './browser.feature'
import { searchSettings } from './settings.search'

const KEY = ENV_BROWSER.audioDefault
let stored: string, enabled: boolean, audio: boolean, putFails: boolean
let puts: { set: Record<string, string>; unset: string[] }[]
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

beforeEach(() => {
  stored = ''; enabled = true; audio = true; putFails = false; puts = []
  resetBrowserStatusCache()
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url.startsWith('/api/browser/status')) return enabled ? json({ enabled: true, binFound: true, live: 0, maxLive: 3, agentEnabled: true, cookieImportEnabled: true, audio, audioDefault: stored !== 'off' }) : json({ error: 'off' }, 404)
    if (url === '/api/settings/env' && init.method === 'PUT') {
      if (putFails) return json({ error: 'nope' }, 500)
      const body = JSON.parse(String(init.body))
      puts.push(body)
      stored = body.set[KEY] ?? ''
      return json({ entries: [] })
    }
    if (url === '/api/settings/env') return json({ entries: [{ key: KEY, value: stored, effective: stored || 'on', default: 'on', editable: true }], locked: false })
    return json({}, 404)
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const sw = (): HTMLElement => screen.getByRole('switch', { name: AUDIO_DEFAULT_TEXT.label })
const ready = async (): Promise<void> => { await waitFor(() => expect(sw().hasAttribute('disabled')).toBe(false)) }

describe('BrowserAudioDefaultField', () => {
  it('is on by default (registry default), with the hint, and has no Reset', async () => {
    render(<BrowserAudioDefaultField />)
    await ready()
    expect(sw().getAttribute('aria-checked')).toBe('true')
    expect(screen.getByText(AUDIO_DEFAULT_TEXT.hint)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Reset Setting/ })).toBeNull()
  })

  it('turning it off saves "off"; Reset removes the override and it is on again', async () => {
    render(<BrowserAudioDefaultField />)
    await ready()
    fireEvent.click(sw())
    await waitFor(() => expect(puts.at(-1)).toEqual({ set: { [KEY]: 'off' }, unset: [] }))
    await waitFor(() => expect(sw().getAttribute('aria-checked')).toBe('false'))
    fireEvent.click(await screen.findByRole('button', { name: `Reset Setting: ${AUDIO_DEFAULT_TEXT.label}` }))
    await waitFor(() => expect(puts.at(-1)).toEqual({ set: {}, unset: [KEY] }))
    await waitFor(() => expect(sw().getAttribute('aria-checked')).toBe('true'))
  })

  it('a failed save rolls back and shows an alert', async () => {
    putFails = true
    render(<BrowserAudioDefaultField />)
    await ready()
    fireEvent.click(sw())
    await screen.findByRole('alert')
    expect(sw().getAttribute('aria-checked')).toBe('true')
  })

  it('browser off: disabled with the reason', async () => {
    enabled = false
    render(<BrowserAudioDefaultField />)
    expect(await screen.findByText(AUDIO_DEFAULT_TEXT.off)).toBeTruthy()
    expect(sw().hasAttribute('disabled')).toBe(true)
  })

  it('server audio kill switch: disabled with the reason', async () => {
    audio = false
    render(<BrowserAudioDefaultField />)
    expect(await screen.findByText(AUDIO_DEFAULT_TEXT.audioOff)).toBeTruthy()
    expect(sw().hasAttribute('disabled')).toBe(true)
  })

  it('is findable in Settings search under Browser', () => {
    expect(searchSettings('mute sound').some((g) => g.entries.some((x) => x.field === 'browser-audio'))).toBe(true)
  })
})
