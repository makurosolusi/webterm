/** @vitest-environment jsdom */
// The wizard steps against a fake server: the Claude check states and the install copy, the browser
// choices (found, none found, off, headless), Central levels written as capabilities, load errors with Retry.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../../shared/settings'
import type { LaunchTest } from '../claudeLauncher/claudeLaunch.client'
import { resetCapabilitiesCache } from '../useCapabilities'
import { BrowserStep } from './setup.browser'
import { claudeCheckState, ClaudeStep } from './setup.claude'
import { capabilityWrites, fakeServer, NOT_FOUND, READY, type FakeServer } from './setup.fakeServer'
import { SETUP_TEXT } from './setup.labels'
import { BasicsStep, CentralStep } from './setup.steps'
import type { StepNav } from './setup.ui'

let nav: StepNav
const click = (name: string | RegExp): void => { fireEvent.click(screen.getByRole('button', { name })) }
const pressed = (name: string): string | null => screen.getByRole('button', { name: new RegExp(`^${name}`) }).getAttribute('aria-pressed')

beforeEach(() => {
  resetCapabilitiesCache()
  nav = { index: 1, total: 4, back: vi.fn(), skip: vi.fn(), next: vi.fn() }
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('Claude step', () => {
  it('maps every probe outcome to a state', () => {
    const fail = (failed: string): LaunchTest => ({ ...NOT_FOUND, failed })
    expect(claudeCheckState(null, false)).toBe('checking')
    expect(claudeCheckState(READY, false)).toBe('ready')
    expect(claudeCheckState(NOT_FOUND, false)).toBe('notFound')
    expect(claudeCheckState(fail('auth_failed'), false)).toBe('notSignedIn')
    expect(claudeCheckState(fail('wrapper_failed'), false)).toBe('wrapperFailed')
    expect(claudeCheckState(fail('wrapper_not_found'), false)).toBe('wrapperFailed')
    expect(claudeCheckState(fail('check_failed'), false)).toBe('checkFailed')
    expect(claudeCheckState(null, true)).toBe('checkFailed')
  })

  it('ready: says so, probes the profile Central uses, shows the provider card', async () => {
    const s = fakeServer()
    render(<ClaudeStep nav={nav} />)
    expect(screen.getByText(SETUP_TEXT.claude.checking)).toBeTruthy()
    expect(await screen.findByText(SETUP_TEXT.claude.ready)).toBeTruthy()
    expect(s.calls.find((c) => c.url === '/api/claude-launch/test')?.body).toEqual({ central: true })
    expect(screen.getByText(SETUP_TEXT.claude.intro)).toBeTruthy()
    expect(await screen.findByRole('region', { name: 'Claude provider' })).toBeTruthy()
    expect(screen.getByText(SETUP_TEXT.changeLater(SETUP_TEXT.claude.where))).toBeTruthy()
  })

  it('not found: both install commands copy, docs link, Check again probes again', async () => {
    const s = fakeServer({ launch: NOT_FOUND })
    const writeText = vi.fn(async () => undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    render(<ClaudeStep nav={nav} />)
    expect(await screen.findByText(SETUP_TEXT.claude.notFound)).toBeTruthy()
    click(`${SETUP_TEXT.claude.copy}: ${SETUP_TEXT.claude.install}`)
    click(`${SETUP_TEXT.claude.copy}: ${SETUP_TEXT.claude.npm}`)
    expect(writeText.mock.calls).toEqual([[NOT_FOUND.steps[0].install?.installCommand], [NOT_FOUND.steps[0].install?.npmCommand]])
    expect(await screen.findAllByText(SETUP_TEXT.claude.copied)).toHaveLength(2)
    expect(screen.getByRole('link', { name: SETUP_TEXT.claude.docs }).getAttribute('href')).toBe('https://code.claude.com/docs/en/setup')
    s.launch = READY
    click(SETUP_TEXT.claude.checkAgain)
    expect(await screen.findByText(SETUP_TEXT.claude.ready)).toBeTruthy()
  })

  it('a failed copy says so instead of claiming success', async () => {
    fakeServer({ launch: NOT_FOUND })
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn(async () => { throw new Error('denied') }) } })
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    render(<ClaudeStep nav={nav} />)
    await screen.findByText(SETUP_TEXT.claude.notFound)
    click(`${SETUP_TEXT.claude.copy}: ${SETUP_TEXT.claude.install}`)
    expect(await screen.findByText(SETUP_TEXT.claude.copyFailed)).toBeTruthy()
  })

  it('check failed: Retry runs the probe again', async () => {
    const s = fakeServer({ launch: 'error' })
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    render(<ClaudeStep nav={nav} />)
    expect(await screen.findByText(SETUP_TEXT.claude.checkFailed)).toBeTruthy()
    s.launch = READY
    click(SETUP_TEXT.retry)
    expect(await screen.findByText(SETUP_TEXT.claude.ready)).toBeTruthy()
  })
})

describe('Browser step', () => {
  const step = async (over: Partial<FakeServer> = {}): Promise<FakeServer> => {
    const s = fakeServer(over)
    render(<BrowserStep nav={nav} />)
    await waitFor(() => expect(screen.queryByText(SETUP_TEXT.browser.loading)).toBeNull())
    return s
  }

  it('a found browser is the default; Continue saves it and turns the browser capability on', async () => {
    const s = await step({ candidates: ['/usr/bin/google-chrome', '/usr/bin/chromium'] })
    expect(pressed(SETUP_TEXT.browser.installed)).toBe('true')
    click('/usr/bin/chromium')
    expect(screen.queryByRole('button', { name: SETUP_TEXT.browser.download })).toBeNull() // no server flag = no slot
    click(SETUP_TEXT.next)
    await waitFor(() => expect(nav.next).toHaveBeenCalled())
    expect(s.chromiumValue).toBe('/usr/bin/chromium')
    expect(capabilityWrites(s)).toEqual(['browser=on'])
  })

  it('none found: Install Chrome link, Check again, and off is the default; Continue turns it off', async () => {
    const s = await step({ candidates: [], on: new Set(['browser']) })
    expect(screen.getByRole('link', { name: SETUP_TEXT.browser.getChrome })).toBeTruthy()
    expect(screen.queryByRole('button', { name: new RegExp(`^${SETUP_TEXT.browser.installed}`) })).toBeNull()
    expect(pressed(SETUP_TEXT.browser.off)).toBe('true')
    click(SETUP_TEXT.browser.checkAgain)
    await waitFor(() => expect(s.calls.some((c) => c.url === '/api/capabilities?refresh=1')).toBe(true))
    click(SETUP_TEXT.next)
    await waitFor(() => expect(nav.next).toHaveBeenCalled())
    expect(capabilityWrites(s)).toEqual(['browser=off'])
  })

  it('headless is off by default and its switch writes the env setting', async () => {
    const s = await step()
    const sw = await screen.findByRole('switch', { name: SETUP_TEXT.browser.headless })
    await waitFor(() => expect(sw.hasAttribute('disabled')).toBe(false))
    expect(sw.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(sw)
    await waitFor(() => expect(s.calls.find((c) => c.method === 'PUT' && c.url === '/api/settings/env')?.body).toEqual({ set: { WEBTERM_BROWSER_HEADLESS: 'on' }, unset: [] }))
  })

  it('a Linux server without a display shows headless locked on with the reason', async () => {
    await step({ extras: { headlessForced: 'no_display' } })
    const sw = screen.getByRole('switch', { name: SETUP_TEXT.browser.headless })
    expect(sw.getAttribute('aria-checked')).toBe('true')
    expect(sw.hasAttribute('disabled')).toBe(true)
    expect(screen.getByText(SETUP_TEXT.browser.headlessLocked)).toBeTruthy()
  })

  it('the Download Chromium slot shows only when the server supports it', async () => {
    await step({ extras: { chromiumDownload: { supported: true } } })
    expect(screen.getByRole('button', { name: SETUP_TEXT.browser.download })).toBeTruthy()
  })

  it('a failed save shows the error and Retry; the step stays', async () => {
    const s = await step({ postFail: true })
    click(SETUP_TEXT.next)
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(nav.next).not.toHaveBeenCalled()
    click(SETUP_TEXT.retry)
    await waitFor(() => expect(nav.next).toHaveBeenCalled())
    expect(s.on.has('browser')).toBe(true)
  })

  it('a load error offers Retry', async () => {
    fakeServer({ capsFail: 1 })
    render(<BrowserStep nav={nav} />)
    expect(await screen.findByText(SETUP_TEXT.browser.loadFailed)).toBeTruthy()
    click(SETUP_TEXT.retry)
    expect(await screen.findByText(SETUP_TEXT.browser.installed)).toBeTruthy()
  })
})

describe('Central step', () => {
  const choose = async (level: keyof typeof SETUP_TEXT.central.modes, on: string[] = []): Promise<string[]> => {
    const s = fakeServer({ on: new Set(on as never[]) })
    render(<CentralStep nav={nav} />)
    click(new RegExp(`^${(await screen.findByText(SETUP_TEXT.central.modes[level])).textContent}`))
    click(SETUP_TEXT.next)
    await waitFor(() => expect(nav.next).toHaveBeenCalled())
    return [...s.on].filter((id) => ['central', 'workers', 'autonomy'].includes(id)).sort()
  }

  it('Off is the default on a fresh install', async () => {
    fakeServer()
    render(<CentralStep nav={nav} />)
    await screen.findByText(SETUP_TEXT.central.modes.off)
    expect(pressed(SETUP_TEXT.central.modes.off)).toBe('true')
  })

  it('each level writes the capability chain', async () => {
    expect(await choose('central', ['autonomy', 'workers', 'central'])).toEqual(['central'])
    cleanup(); resetCapabilitiesCache(); nav.next = vi.fn()
    expect(await choose('workers', ['autonomy', 'workers', 'central'])).toEqual(['central', 'workers'])
    cleanup(); resetCapabilitiesCache(); nav.next = vi.fn()
    expect(await choose('autonomy')).toEqual(['autonomy', 'central', 'workers'])
    cleanup(); resetCapabilitiesCache(); nav.next = vi.fn()
    expect(await choose('off', ['workers', 'central'])).toEqual([])
  })

  it('a chosen level shows which launch profile Central uses', async () => {
    fakeServer({ on: new Set(['central']) })
    render(<CentralStep nav={nav} />)
    expect(await screen.findByText('Launch profile: Default')).toBeTruthy()
  })
})

describe('Basics step', () => {
  it('theme tiles patch appTheme; telemetry line and Telegram later link are shown', async () => {
    fakeServer()
    const update = vi.fn()
    render(<BasicsStep nav={{ ...nav, index: 3 }} settings={DEFAULT_SETTINGS} update={update} />)
    expect(pressed(SETUP_TEXT.basics.themes.auto)).toBe('true')
    click(SETUP_TEXT.basics.themes.dark)
    expect(update).toHaveBeenCalledWith({ appTheme: 'dark' })
    expect(screen.getByText(SETUP_TEXT.basics.telemetry)).toBeTruthy()
    const opened = vi.fn()
    window.addEventListener('webterm:open-settings', opened)
    click(SETUP_TEXT.basics.telegramLater)
    expect((opened.mock.calls[0][0] as CustomEvent).detail).toEqual({ section: 'capabilities' })
    expect(screen.getByRole('button', { name: SETUP_TEXT.finish })).toBeTruthy()
    expect(await screen.findByText(/In use:/)).toBeTruthy()
  })
})
