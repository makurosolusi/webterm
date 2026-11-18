/** @vitest-environment jsdom */
// Settings > Browser > Active browsers limit: stepper bounds and keys, Reset, save + rollback, "Active now", the
// over-limit line, the high-value warning, the off state and the Settings search entry.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ENV_BROWSER, MAX_LIVE_RANGE } from '../shared/browser.contract'
import { BrowserLimitField, LIMIT_TEXT } from './BrowserLimitField'
import { searchSettings } from './settings.search'

const KEY = ENV_BROWSER.maxLive
let stored: string
let live: number
let enabled: boolean
let putFails: boolean
let puts: { set: Record<string, string>; unset: string[] }[]

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

beforeEach(() => {
  stored = ''; live = 1; enabled = true; putFails = false; puts = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url.startsWith('/api/browser/status')) return enabled ? json({ enabled: true, binFound: true, live, maxLive: Number(stored) || 3, agentEnabled: true, cookieImportEnabled: true }) : json({ error: 'off' }, 404)
    if (url === '/api/settings/env' && init.method === 'PUT') {
      if (putFails) return json({ error: 'nope' }, 500)
      const body = JSON.parse(String(init.body))
      puts.push(body)
      stored = body.set[KEY] ?? ''
      return json({ entries: [] })
    }
    if (url === '/api/settings/env') return json({ entries: [{ key: KEY, value: stored, effective: stored || '3', default: '3', editable: true }], locked: false })
    return json({}, 404)
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const spin = (): HTMLElement => screen.getByRole('spinbutton', { name: LIMIT_TEXT.label })
const ready = async (): Promise<void> => { await waitFor(() => expect(screen.getByRole('button', { name: `Increase ${LIMIT_TEXT.label}` }).hasAttribute('disabled')).toBe(false)) }

describe('BrowserLimitField', () => {
  it('shows the default 3, the hint and "Active now: 1 of 3"', async () => {
    render(<BrowserLimitField />)
    await ready()
    expect(spin().getAttribute('aria-valuenow')).toBe('3')
    expect(spin().getAttribute('aria-valuemin')).toBe('1')
    expect(spin().getAttribute('aria-valuemax')).toBe(String(MAX_LIVE_RANGE.max))
    expect(screen.getByText(LIMIT_TEXT.hint)).toBeTruthy()
    await waitFor(() => expect(screen.getByTestId('browser-limit-live').textContent).toBe('Active now: 1 of 3'))
  })

  it('+ and - save one step each through the env PUT and update the value at once', async () => {
    render(<BrowserLimitField />)
    await ready()
    fireEvent.click(screen.getByRole('button', { name: `Increase ${LIMIT_TEXT.label}` }))
    await waitFor(() => expect(puts).toEqual([{ set: { [KEY]: '4' }, unset: [] }]))
    expect(spin().getAttribute('aria-valuenow')).toBe('4')
    fireEvent.click(screen.getByRole('button', { name: `Decrease ${LIMIT_TEXT.label}` }))
    await waitFor(() => expect(puts.at(-1)).toEqual({ set: { [KEY]: '3' }, unset: [] }))
  })

  it('stops at the range ends: 1 disables -, the maximum disables +', async () => {
    stored = '1'
    render(<BrowserLimitField />)
    await ready()
    expect(screen.getByRole('button', { name: `Decrease ${LIMIT_TEXT.label}` }).hasAttribute('disabled')).toBe(true)
    cleanup()
    stored = String(MAX_LIVE_RANGE.max)
    render(<BrowserLimitField />)
    await waitFor(() => expect(spin().getAttribute('aria-valuenow')).toBe(String(MAX_LIVE_RANGE.max)))
    expect(screen.getByRole('button', { name: `Increase ${LIMIT_TEXT.label}` }).hasAttribute('disabled')).toBe(true)
  })

  it('steps with the arrow keys, Home and End', async () => {
    render(<BrowserLimitField />)
    await ready()
    fireEvent.keyDown(spin(), { key: 'ArrowUp' })
    await waitFor(() => expect(puts.at(-1)?.set[KEY]).toBe('4'))
    fireEvent.keyDown(spin(), { key: 'End' })
    await waitFor(() => expect(puts.at(-1)?.set[KEY]).toBe(String(MAX_LIVE_RANGE.max)))
    fireEvent.keyDown(spin(), { key: 'Home' })
    await waitFor(() => expect(puts.at(-1)?.set[KEY]).toBe('1'))
  })

  it('Reset removes the override (back to the default 3) and only shows when modified', async () => {
    stored = '5'
    render(<BrowserLimitField />)
    await waitFor(() => expect(spin().getAttribute('aria-valuenow')).toBe('5'))
    fireEvent.click(await screen.findByRole('button', { name: `Reset Setting: ${LIMIT_TEXT.label}` }))
    await waitFor(() => expect(puts.at(-1)).toEqual({ set: {}, unset: [KEY] }))
    await waitFor(() => expect(spin().getAttribute('aria-valuenow')).toBe('3'))
    expect(screen.queryByRole('button', { name: /^Reset Setting/ })).toBeNull()
  })

  it('rolls back to the old value and offers Retry when the save fails', async () => {
    putFails = true
    render(<BrowserLimitField />)
    await ready()
    fireEvent.click(screen.getByRole('button', { name: `Increase ${LIMIT_TEXT.label}` }))
    await screen.findByRole('alert')
    expect(spin().getAttribute('aria-valuenow')).toBe('3')
    putFails = false
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(puts.at(-1)?.set[KEY]).toBe('4'))
  })

  it('warns above 6 and not at 6', async () => {
    stored = '6'
    render(<BrowserLimitField />)
    await waitFor(() => expect(spin().getAttribute('aria-valuenow')).toBe('6'))
    expect(screen.queryByText(LIMIT_TEXT.highWarning)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: `Increase ${LIMIT_TEXT.label}` }))
    expect(await screen.findByText(LIMIT_TEXT.highWarning)).toBeTruthy()
  })

  it('says how many are active when the limit is below that, and keeps polling the live count', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      stored = '2'; live = 4
      render(<BrowserLimitField />)
      await waitFor(() => expect(screen.getByTestId('browser-limit-live').textContent).toBe('4 active now; extra browsers will be paused when hidden'))
      live = 1
      await act(async () => { await vi.advanceTimersByTimeAsync(5100) })
      await waitFor(() => expect(screen.getByTestId('browser-limit-live').textContent).toBe('Active now: 1 of 2'))
    } finally { vi.useRealTimers() }
  })

  it('is locked with a reason while the browser is off', async () => {
    enabled = false
    render(<BrowserLimitField />)
    expect(await screen.findByText(LIMIT_TEXT.off)).toBeTruthy()
    expect(screen.getByRole('button', { name: `Increase ${LIMIT_TEXT.label}` }).hasAttribute('disabled')).toBe(true)
  })

  it('is found by the Settings search under the words people type', () => {
    for (const q of ['browser limit', 'max browsers', 'active browsers']) {
      expect(searchSettings(q).some((g) => g.entries.some((x) => x.field === 'browser-limit')), q).toBe(true)
    }
  })
})
