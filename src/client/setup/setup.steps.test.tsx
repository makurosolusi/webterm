/** @vitest-environment jsdom */
// The wizard steps against a fake server: the Claude check states and the install copy, the browser
// choices (found, none found, off, headless), Central levels written as capabilities, load errors with Retry.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../../shared/settings'
import { resetCapabilitiesCache } from '../useCapabilities'
import { BrowserStep } from './setup.browser'
import { ClaudeStep } from './setup.claude'
import { CONNECTION_TEXT } from '../claudeLauncher/ConnectionTest'
import { DOWNLOAD_TEXT } from '../advancedLabels'
import { capabilityWrites, CONN_NOT_FOUND, CONN_OK, CONN_WRAPPER_SIGNED_OUT, DL_IDLE, fakeServer, type FakeServer } from './setup.fakeServer'
import { PROVIDER_TEXT } from '../ClaudeProviderCard'
import { SETUP_TEXT } from './setup.labels'
import { NOTIFY_TEXT } from '../osNotify.settings'
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
  const test = CONNECTION_TEXT.button
  const probes = (s: FakeServer): number => s.calls.filter((c) => c.url === '/api/claude-provider/test').length

  const rows = (): string[] => [...document.querySelectorAll('[data-stage]')].map((r) => `${(r as HTMLElement).dataset.stage}:${(r as HTMLElement).dataset.state}`)

  it('on open: the check without the request (no tokens) is the single status; request stays pending, no "works" claim', async () => {
    const s = fakeServer()
    render(<ClaudeStep nav={nav} />)
    expect(await screen.findByText(/^Ready to test — the last check sends one small request$/)).toBeTruthy()
    expect(rows()).toEqual(['wrapper:skipped', 'cli:ok', 'auth:ok', 'request:pending'])
    expect(screen.getByText(/Not tested yet — press Test connection to send a test request/)).toBeTruthy()
    expect(screen.queryByText(/Connection works/)).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(s.calls.filter((c) => c.url === '/api/claude-provider/test').map((c) => c.body)).toEqual([{ request: false }])
    expect(document.querySelectorAll('[data-connection-test]')).toHaveLength(1)
    expect(s.calls.some((c) => c.url === '/api/claude-launch/test')).toBe(false)
  })

  it('Test connection runs all four stages, request included; success names what passed', async () => {
    const s = fakeServer()
    render(<ClaudeStep nav={nav} />)
    await screen.findByText(/^Ready to test/)
    click(test.idle)
    expect(await screen.findByText(/^Connection works — Claude answered in 1.4 s via Claude Code login$/)).toBeTruthy()
    expect(rows()).toEqual(['wrapper:skipped', 'cli:ok', 'auth:ok', 'request:ok'])
    expect(s.calls.filter((c) => c.url === '/api/claude-provider/test').map((c) => c.body)).toEqual([{ request: false }, { request: true }])
    expect(screen.getByRole('button', { name: test.again })).toBeTruthy()
    expect(s.calls.some((c) => c.url === '/api/claude-launch/test')).toBe(false)
    expect(screen.getByText(SETUP_TEXT.description.claude)).toBeTruthy()
    expect(await screen.findByRole('region', { name: 'Connection' })).toBeTruthy()
    expect(screen.getByText(SETUP_TEXT.changeLater(SETUP_TEXT.claude.where))).toBeTruthy()
  })

  it('not found: fails at Claude CLI with both install commands to copy and the guide; Test again re-runs the same test', async () => {
    const s = fakeServer({ connection: CONN_NOT_FOUND })
    const writeText = vi.fn(async () => undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    render(<ClaudeStep nav={nav} />)
    expect((await screen.findByRole('alert')).textContent).toContain('Failed at Claude CLI: The claude CLI was not found on PATH.')
    click(`${CONNECTION_TEXT.copy}: ${CONNECTION_TEXT.install}`)
    click(`${CONNECTION_TEXT.copy}: ${CONNECTION_TEXT.npm}`)
    expect(writeText.mock.calls).toEqual([['curl -fsSL https://claude.ai/install.sh | bash'], ['npm install -g @anthropic-ai/claude-code']])
    expect(await screen.findAllByText(CONNECTION_TEXT.copied)).toHaveLength(2)
    expect(screen.getByRole('link', { name: CONNECTION_TEXT.docs }).getAttribute('href')).toBe('https://code.claude.com/docs/en/setup')
    s.connection = CONN_OK
    click(test.again)
    expect(await screen.findByText(/^Connection works/)).toBeTruthy()
    expect(probes(s)).toBe(2)
    expect(s.calls.filter((c) => c.url === '/api/claude-provider/test')[1]!.body).toEqual({ request: true })
  })

  it('wrapper not signed in: one failure surface with the sign-in command to copy; the card\'s Test re-runs it and shows nothing of its own', async () => {
    const cardFailure = 'The launch command exited with code 1 before Claude Code started.'
    const s = fakeServer({
      connection: CONN_WRAPPER_SIGNED_OUT,
      provider: { provider: { mode: 'apiKey', secretSet: true, ready: true }, lastTest: { ok: false, message: cardFailure, at: 1 }, restartNeeded: 0 },
    })
    const writeText = vi.fn(async () => undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    render(<ClaudeStep nav={nav} />)
    expect((await screen.findByRole('alert')).textContent).toContain('Failed at Wrapper')
    expect(screen.getByText('envman is not signed in for the user webterm runs as. Sign in, then Check again.')).toBeTruthy()
    click(`${CONNECTION_TEXT.copy}: ${CONNECTION_TEXT.signIn}`)
    expect(writeText.mock.calls).toEqual([['envman login <server> --token <token>']])
    const before = probes(s)
    click(test.again)
    await waitFor(() => expect(probes(s)).toBe(before + 1))
    expect(await screen.findAllByRole('alert')).toHaveLength(1)
    expect(document.querySelectorAll('[data-connection-test]')).toHaveLength(1)
    expect(screen.queryByText(new RegExp(cardFailure))).toBeNull()
  })

  it('no separate Save: Continue with nothing changed just moves on', async () => {
    const s = fakeServer()
    render(<ClaudeStep nav={nav} />)
    await screen.findByText(/^Ready to test/)
    expect(screen.queryByRole('button', { name: new RegExp(`^(${PROVIDER_TEXT.save}|${PROVIDER_TEXT.clean})$`) })).toBeNull()
    click(SETUP_TEXT.next)
    await waitFor(() => expect(nav.next).toHaveBeenCalledTimes(1))
    expect(s.calls.filter((c) => c.method === 'PUT')).toHaveLength(0)
  })

  it('Continue saves pending provider edits first, then moves on; a failed save keeps the step with the error', async () => {
    const s = fakeServer({ providerSaveFail: true })
    render(<ClaudeStep nav={nav} />)
    fireEvent.click(await screen.findByRole('radio', { name: PROVIDER_TEXT.modes.apiKey }))
    fireEvent.change(screen.getByLabelText(PROVIDER_TEXT.key), { target: { value: 'sk-test-only' } }) // test-only
    click(SETUP_TEXT.next)
    expect(await screen.findByText(SETUP_TEXT.claude.saveFailed)).toBeTruthy()
    expect(screen.getAllByRole('alert').some((a) => a.textContent === PROVIDER_TEXT.saveFailed('write_failed'))).toBe(true)
    expect(nav.next).not.toHaveBeenCalled()
    click(SETUP_TEXT.retry)
    await waitFor(() => expect(nav.next).toHaveBeenCalledTimes(1))
    const puts = s.calls.filter((c) => c.method === 'PUT' && c.url === '/api/claude-provider')
    expect(puts).toHaveLength(2)
    expect(puts[1]!.body).toMatchObject({ mode: 'apiKey', secret: 'sk-test-only' })
  })

  it('a failed copy says so instead of claiming success', async () => {
    fakeServer({ connection: CONN_NOT_FOUND })
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn(async () => { throw new Error('denied') }) } })
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    render(<ClaudeStep nav={nav} />)
    fireEvent.click(await screen.findByRole('button', { name: `${CONNECTION_TEXT.copy}: ${CONNECTION_TEXT.install}` }))
    expect(await screen.findByText(CONNECTION_TEXT.copyFailed)).toBeTruthy()
  })

  it('a test that cannot run says so; Test again runs it again', async () => {
    const s = fakeServer({ connection: 'error' })
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    render(<ClaudeStep nav={nav} />)
    expect(await screen.findByText(CONNECTION_TEXT.couldNotRun('probe_failed'))).toBeTruthy()
    s.connection = CONN_OK
    click(test.again)
    expect(await screen.findByText(/^Connection works/)).toBeTruthy()
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
    await step({ extras: { chromiumDownload: { supported: true, state: 'idle', percent: 0 } } })
    expect(screen.getByRole('button', { name: SETUP_TEXT.browser.download })).toBeTruthy()
    cleanup()
    resetCapabilitiesCache()
    await step({ extras: { chromiumDownload: { supported: false, state: 'idle', percent: 0 } } })
    expect(screen.queryByRole('button', { name: SETUP_TEXT.browser.download })).toBeNull()
  })

  it('Download Chromium: start, progress with Cancel, done selects it and Continue turns the browser on', async () => {
    const s = await step({ candidates: [], extras: { chromiumDownload: { supported: true, state: 'idle', percent: 0 } } })
    click(SETUP_TEXT.browser.download)
    const startBtn = await screen.findByRole('button', { name: DOWNLOAD_TEXT.start })
    expect((screen.getByRole('button', { name: SETUP_TEXT.next }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(startBtn)
    await waitFor(() => expect(s.calls.some((c) => c.method === 'POST' && c.url === '/api/capabilities/chromium-download')).toBe(true))
    expect(await screen.findByRole('button', { name: DOWNLOAD_TEXT.cancel })).toBeTruthy()
    s.download = { ...DL_IDLE, state: 'downloading', percent: 42 }
    await waitFor(() => expect(screen.getByRole('progressbar', { name: DOWNLOAD_TEXT.progressLabel }).getAttribute('aria-valuenow')).toBe('42'), { timeout: 2000 })
    expect(screen.getByText(DOWNLOAD_TEXT.progress(42))).toBeTruthy()
    const managed = '/data/browser/chrome-for-testing/1/chrome-linux64/chrome'
    s.candidates = [managed]
    s.download = { ...DL_IDLE, state: 'done', percent: 100, executablePath: managed }
    expect(await screen.findByText(managed, {}, { timeout: 2000 })).toBeTruthy()
    await waitFor(() => expect(s.calls.filter((c) => c.url === '/api/capabilities' && c.method === 'GET').length).toBeGreaterThan(1)) // reloaded after done
    expect(pressed(SETUP_TEXT.browser.download)).toBe('true')
    click(SETUP_TEXT.next)
    await waitFor(() => expect(nav.next).toHaveBeenCalled())
    expect(capabilityWrites(s)).toEqual(['browser=on'])
    expect(s.calls.some((c) => c.url === '/api/capabilities/advanced')).toBe(false) // managed Chrome needs no saved path
    expect(s.chromiumValue).toBe('') // no WEBTERM_BROWSER_BIN override
  })

  it('Download Chromium: an automatic retry is shown with Cancel; each failure kind has its message and Try again', async () => {
    const s = await step({ extras: { chromiumDownload: { supported: true, state: 'downloading', percent: 5 } }, download: { ...DL_IDLE, state: 'retrying', retry: { attempt: 2, max: 4 } } })
    expect(await screen.findByText(DOWNLOAD_TEXT.autoRetry(2, 4))).toBeTruthy()
    expect(screen.getByRole('button', { name: DOWNLOAD_TEXT.cancel })).toBeTruthy()
    for (const kind of ['network', 'disk', 'checksum', 'other'] as const) {
      s.download = { ...DL_IDLE, state: 'failed', errorKind: kind, error: `message for ${kind}` }
      cleanup()
      render(<BrowserStep nav={nav} />)
      expect(await screen.findByText(`message for ${kind}`)).toBeTruthy()
      expect(document.querySelector(`[data-error-kind="${kind}"]`)).toBeTruthy()
      expect(screen.getByRole('button', { name: DOWNLOAD_TEXT.retry })).toBeTruthy()
    }
  })

  it('a saved WEBTERM_BROWSER_BIN override is called out as a custom, unverified browser', async () => {
    await step({ candidates: [], chromiumValue: '/opt/my-chrome' })
    expect(screen.getByText(SETUP_TEXT.browser.customActive('/opt/my-chrome'))).toBeTruthy()
  })

  it('Download Chromium: Cancel returns to the start button; a failure shows the reason and Retry starts again', async () => {
    const s = await step({ extras: { chromiumDownload: { supported: true, state: 'downloading', percent: 5 } }, download: { ...DL_IDLE, state: 'downloading', percent: 5 } })
    expect(pressed(SETUP_TEXT.browser.download)).toBe('true') // a running download is the default choice
    fireEvent.click(await screen.findByRole('button', { name: DOWNLOAD_TEXT.cancel }))
    expect(await screen.findByRole('button', { name: DOWNLOAD_TEXT.start })).toBeTruthy()
    s.download = { ...DL_IDLE, state: 'failed', error: 'Not enough free disk space to download Chromium (about 600 MB is needed).' }
    cleanup()
    render(<BrowserStep nav={nav} />)
    expect(await screen.findByText(/Not enough free disk space/)).toBeTruthy()
    click(DOWNLOAD_TEXT.retry)
    expect(await screen.findByRole('button', { name: DOWNLOAD_TEXT.cancel })).toBeTruthy()
  })

  it('Download Chromium: an unreachable server says so and Retry reads the status again', async () => {
    const s = await step({ extras: { chromiumDownload: { supported: true, state: 'idle', percent: 0 } }, downloadFail: true })
    click(SETUP_TEXT.browser.download)
    expect(await screen.findByText(DOWNLOAD_TEXT.unreachable)).toBeTruthy()
    click(DOWNLOAD_TEXT.retry)
    expect(await screen.findByRole('button', { name: DOWNLOAD_TEXT.start })).toBeTruthy()
    expect(s.calls.filter((c) => c.url === '/api/capabilities/chromium-download').length).toBe(2)
  })

  it('a failed save shows the error and Retry; the step stays', async () => {
    const s = await step({ postFail: true })
    click(SETUP_TEXT.next)
    expect(screen.getByRole('button', { name: SETUP_TEXT.saving }).getAttribute('aria-busy')).toBe('true')
    expect((await screen.findByRole('alert')).textContent).toContain(SETUP_TEXT.browser.saveFailed)
    expect(document.querySelector('[data-action-result="failed"]')).toBeTruthy()
    expect(nav.next).not.toHaveBeenCalled()
    click(SETUP_TEXT.retry)
    await waitFor(() => expect(nav.next).toHaveBeenCalled())
    expect(s.on.has('browser')).toBe(true)
  })

  it('a load error offers Retry', async () => {
    fakeServer({ capsFail: 1 })
    render(<BrowserStep nav={nav} />)
    expect(await screen.findByText(SETUP_TEXT.browser.loadFailed)).toBeTruthy()
    expect(screen.getByText(SETUP_TEXT.waitForLoad)).toBeTruthy() // Continue says why it is locked
    click(SETUP_TEXT.retry)
    expect(screen.getByRole('button', { name: SETUP_TEXT.retrying }).getAttribute('aria-busy')).toBe('true')
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
    expect((opened.mock.calls[0][0] as CustomEvent).detail).toEqual({ section: 'capabilities', field: 'capability.telegram' })
    click(SETUP_TEXT.openSettings) // the quiet "change later" line links to the exact setting
    expect((opened.mock.calls[1][0] as CustomEvent).detail).toEqual({ section: 'appearance', field: 'appTheme' })
    window.removeEventListener('webterm:open-settings', opened)
    expect(screen.getByRole('button', { name: SETUP_TEXT.finish })).toBeTruthy()
    expect(screen.getByRole('combobox', { name: 'Default projects folder' })).toBeTruthy() // the projects folder row, Browse + recent
  })

  const notifySwitch = (): HTMLElement => screen.getByRole('switch', { name: SETUP_TEXT.basics.notify })
  const stubNotification = (permission: NotificationPermission, answer: NotificationPermission = permission): ReturnType<typeof vi.fn> => {
    const requestPermission = vi.fn(async () => answer)
    vi.stubGlobal('Notification', { permission, requestPermission })
    return requestPermission
  }

  it('notifications blocked by the browser: switch off and locked with the unblock steps, even if the saved pref is on', async () => {
    fakeServer()
    localStorage.setItem('webterm.osNotify', JSON.stringify({ enabled: true }))
    stubNotification('denied')
    render(<BasicsStep nav={{ ...nav, index: 3 }} settings={DEFAULT_SETTINGS} update={vi.fn()} />)
    expect(notifySwitch().getAttribute('aria-checked')).toBe('false')
    expect((notifySwitch() as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(NOTIFY_TEXT.blocked)).toBeTruthy()
    localStorage.removeItem('webterm.osNotify')
  })

  it('turning notifications on asks the browser; a refusal keeps it off and says so', async () => {
    fakeServer()
    const ask = stubNotification('default', 'denied')
    render(<BasicsStep nav={{ ...nav, index: 3 }} settings={DEFAULT_SETTINGS} update={vi.fn()} />)
    fireEvent.click(notifySwitch())
    await waitFor(() => expect(ask).toHaveBeenCalledTimes(1))
    expect((await screen.findByRole('alert')).textContent).toBe(NOTIFY_TEXT.refused)
    expect(notifySwitch().getAttribute('aria-checked')).toBe('false')
    localStorage.removeItem('webterm.osNotify')
  })
})
