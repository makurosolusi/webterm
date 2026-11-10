/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CAPABILITY_IDS, CAPABILITIES, type CapabilitiesResponse, type CapabilityId } from '../shared/featureCapabilities'
import { DEFAULT_SETTINGS } from '../shared/settings'
import { SettingsPanel } from './SettingsPanel'
import { resetCapabilitiesCache } from './useCapabilities'

// test-only fixtures
const SWITCH = 'Let Central check in by itself'
const LIMIT = 'Check-ins per day'
const CHECKIN = '/api/central/checkin-settings'
let central: boolean
let state: { enabled: boolean; dailyLimit: number; usedToday: number }
let posts: unknown[]
let holdPost: Promise<void> | null
let failGet: boolean

const caps = (): CapabilitiesResponse => ({
  capabilities: CAPABILITY_IDS.map((id: CapabilityId) => ({ id, title: CAPABILITIES[id].title, blurb: CAPABILITIES[id].blurb, status: id === 'central' && central ? 'on' : 'off' })),
  advanced: { agentEngine: { value: 'auto', detected: 'claude' }, chromiumPath: { value: '', detected: false, active: null, source: null, overrideInvalid: false, candidates: [] }, dataDir: '/tmp/d' },
})
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

beforeEach(() => {
  central = true
  state = { enabled: false, dailyLimit: 10, usedToday: 2 }
  posts = []
  holdPost = null
  failGet = false
  resetCapabilitiesCache()
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url.startsWith('/api/capabilities')) return json(caps())
    if (url === '/api/settings/env') return json({ locked: false, entries: [] })
    if (url === CHECKIN && init.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Partial<typeof state>
      posts.push(body)
      if (holdPost) await holdPost
      state = { ...state, ...body }
      return json(state)
    }
    if (url === CHECKIN) return failGet ? json({ error: 'boom' }, 500) : json(state)
    return json({ items: [] })
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

const open = (): void => { render(<SettingsPanel settings={DEFAULT_SETTINGS} onChange={vi.fn()} onClose={vi.fn()} initialSection="central" />) }
const ready = async (): Promise<HTMLButtonElement> => {
  open()
  await screen.findByText('Used today: 2 of 10')
  const sw = screen.getByRole('switch', { name: SWITCH }) as HTMLButtonElement
  await waitFor(() => expect(sw.hasAttribute('disabled')).toBe(false))
  return sw
}

describe('check-in settings', () => {
  it('shows the state and the used count', async () => {
    const sw = await ready()
    expect(sw.getAttribute('aria-checked')).toBe('false')
    expect((screen.getByLabelText(LIMIT) as HTMLSelectElement).value).toBe('10')
    expect(Array.from((screen.getByLabelText(LIMIT) as HTMLSelectElement).options).map((o) => o.value)).toEqual(['5', '10', '20', '50'])
  })

  it('the switch posts only enabled and applies what the server answers', async () => {
    const sw = await ready()
    fireEvent.click(sw)
    await waitFor(() => expect(sw.getAttribute('aria-checked')).toBe('true'))
    expect(posts).toEqual([{ enabled: true }])
  })

  it('the select posts only dailyLimit and the used count follows', async () => {
    await ready()
    fireEvent.change(screen.getByLabelText(LIMIT), { target: { value: '20' } })
    expect(await screen.findByText('Used today: 2 of 20')).toBeTruthy()
    expect(posts).toEqual([{ dailyLimit: 20 }])
  })

  it('a double click sends once', async () => {
    let release: () => void = () => undefined
    holdPost = new Promise((r) => { release = r })
    const sw = await ready()
    fireEvent.click(sw)
    fireEvent.click(sw)
    release()
    await waitFor(() => expect(sw.getAttribute('aria-checked')).toBe('true'))
    expect(posts).toHaveLength(1)
  })

  it('a failed read says so, offers Retry, and leaves the controls off', async () => {
    failGet = true
    open()
    const alert = await screen.findByText(/Could not load the check-in settings/)
    expect(screen.getByRole('switch', { name: SWITCH }).hasAttribute('disabled')).toBe(true)
    failGet = false
    fireEvent.click(alert.querySelector('button') as HTMLButtonElement)
    expect(await screen.findByText('Used today: 2 of 10')).toBeTruthy()
  })

  it('needs Central on', async () => {
    central = false
    open()
    await screen.findByText('Used today: 2 of 10')
    expect(screen.getByRole('switch', { name: SWITCH }).hasAttribute('disabled')).toBe(true)
  })
})
