/** @vitest-environment jsdom */
// The wizard shell: hidden without ?setup=, resumes at the first unfinished step, ?setup=<step> opens
// there, Skip / Back / Continue PATCH progress per step, Escape keeps progress, Finish sets completedAt.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type Settings } from '../../shared/settings'
import { applySettingsPatch, type SettingsPatch } from '../../shared/settings.patch'
import { AppRouteSync } from '../appRoute'
import { registerCommands } from '../commandRegistry'
import { resetCapabilitiesCache } from '../useCapabilities'
import SetupDialog from './SetupDialog'
import { CONN_NOT_FOUND, fakeServer } from './setup.fakeServer'
import { CONNECTION_TEXT } from '../claudeLauncher/ConnectionTest'
import { SETUP_TEXT } from './setup.labels'
import { openSetup } from './setup.open'

let patches: SettingsPatch[] = []
let where = ''

function Where(): null {
  const l = useLocation()
  where = l.pathname + l.search
  return null
}

function Harness({ initial }: { initial: Settings }): React.JSX.Element {
  const [s, setS] = useState(initial)
  return (
    <>
      <AppRouteSync />
      <Where />
      <SetupDialog settings={s} update={(p) => { patches.push(p); setS((x) => applySettingsPatch(x, p)) }} />
    </>
  )
}

const withSteps = (steps: Settings['setup']['steps']): Settings => ({ ...DEFAULT_SETTINGS, setup: { completedAt: null, steps } })
const mount = (url: string, s: Settings = DEFAULT_SETTINGS) => render(<MemoryRouter initialEntries={[url]}><Harness initial={s} /></MemoryRouter>)
const heading = (): string => document.querySelector('[data-setup-heading]')?.textContent ?? ''
const click = (name: string | RegExp): void => { fireEvent.click(screen.getByRole('button', { name })) }

beforeEach(() => { patches = []; where = ''; resetCapabilitiesCache(); fakeServer() })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('SetupDialog', () => {
  it('renders nothing without ?setup=', () => {
    mount('/')
    expect(screen.queryByText(SETUP_TEXT.title)).toBeNull()
  })

  it('?setup=1 resumes at the first unfinished step and shows the step marks', async () => {
    mount('/?setup=1', withSteps({ claude: 'done', browser: 'skipped' }))
    expect(heading()).toBe(SETUP_TEXT.steps.central)
    expect(screen.getByText(SETUP_TEXT.stepOf(3, 4))).toBeTruthy()
    const state = (s: string): string | null => document.querySelector(`[data-step="${s}"]`)?.getAttribute('data-state') ?? null
    expect([state('claude'), state('browser'), state('central'), state('basics')]).toEqual(['done', 'skipped', 'current', 'todo'])
    await screen.findByText(SETUP_TEXT.central.modes.off)
  })

  it('?setup=browser opens at that step', async () => {
    mount('/?setup=browser')
    expect(heading()).toBe(SETUP_TEXT.steps.browser)
    await screen.findByText(SETUP_TEXT.browser.installed)
  })

  it('openSetup(step) opens the wizard through the URL', async () => {
    mount('/')
    act(() => openSetup('central'))
    await waitFor(() => expect(where).toBe('/?setup=central'))
    expect(heading()).toBe(SETUP_TEXT.steps.central)
  })

  it('Skip patches only that step and moves on; Back returns without a patch', async () => {
    mount('/?setup=claude')
    click(SETUP_TEXT.skip)
    expect(patches).toEqual([{ setup: { steps: { claude: 'skipped' } } }])
    expect(heading()).toBe(SETUP_TEXT.steps.browser)
    click(SETUP_TEXT.back)
    expect(heading()).toBe(SETUP_TEXT.steps.claude)
    expect(patches).toHaveLength(1)
    expect(screen.queryByRole('button', { name: SETUP_TEXT.back })).toBeNull() // first step has no Back
  })

  it('Continue marks the step done', async () => {
    mount('/?setup=claude')
    click(SETUP_TEXT.next)
    await waitFor(() => expect(patches).toEqual([{ setup: { steps: { claude: 'done' } } }]))
    // Route navigation (setSetup) settles after the patch, so the heading is awaited too.
    await waitFor(() => expect(heading()).toBe(SETUP_TEXT.steps.browser))
  })

  it('Escape closes, keeps progress, and clears ?setup=', async () => {
    mount('/?setup=claude')
    click(SETUP_TEXT.skip)
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByText(SETUP_TEXT.title)).toBeNull())
    expect(where).toBe('/')
    expect(patches).toHaveLength(1)
  })

  it('focus moves into the modal', async () => {
    mount('/?setup=claude')
    await waitFor(() => expect(document.querySelector('[data-setup-dialog]')?.contains(document.activeElement)).toBe(true))
  })

  it('Finish on the last step sets completedAt and shows the Done panel with the project actions', async () => {
    const run = vi.fn()
    const off = registerCommands([{ id: 'workspace.newProject', label: 'Workspace: New Project…', run }])
    mount('/?setup=basics', withSteps({ claude: 'done', browser: 'done', central: 'done' }))
    click(SETUP_TEXT.finish)
    await screen.findByText(SETUP_TEXT.doneBody)
    const p = patches.at(-1)?.setup
    expect(p?.steps).toEqual({ basics: 'done' })
    expect(typeof p?.completedAt).toBe('number')
    expect(screen.queryByRole('button', { name: SETUP_TEXT.doneActions.clone })).toBeNull() // command not registered = hidden
    click(SETUP_TEXT.doneActions.newProject)
    expect(run).toHaveBeenCalledOnce()
    await waitFor(() => expect(where).toBe('/'))
    off()
  })

  describe('frame and stepper', () => {
    const item = (s: string): HTMLElement => document.querySelector(`[data-step="${s}"]`) as HTMLElement
    const footer = (): HTMLElement => document.querySelector('[data-setup-footer]') as HTMLElement

    it('numbered stepper: done / skipped / current / upcoming, aria-current only on the current step', async () => {
      mount('/?setup=central', withSteps({ claude: 'done', browser: 'skipped' }))
      const current = document.querySelectorAll('[aria-current="step"]')
      expect(current).toHaveLength(1)
      expect(current[0]).toBe(item('central'))
      expect(item('claude').querySelector('.setup-marker .codicon-check')).toBeTruthy()
      expect(item('browser').querySelector('.setup-marker .codicon-circle-slash')).toBeTruthy()
      expect(item('basics').querySelector('.setup-marker')?.textContent).toBe('4')
      // Answered steps go back; the current and upcoming ones are not buttons.
      expect(item('claude').querySelector('button')).toBeTruthy()
      expect(item('browser').querySelector('button')).toBeTruthy()
      expect(item('central').querySelector('button')).toBeNull()
      expect(item('basics').querySelector('button')).toBeNull()
      expect(screen.getByRole('navigation', { name: SETUP_TEXT.progress })).toBeTruthy()
      await screen.findByText(SETUP_TEXT.central.modes.off)
    })

    it('a done step in the stepper reopens it without a patch; aria-current follows', async () => {
      mount('/?setup=browser', withSteps({ claude: 'done' }))
      fireEvent.click(item('claude').querySelector('button')!)
      await waitFor(() => expect(heading()).toBe(SETUP_TEXT.steps.claude))
      expect(where).toBe('/?setup=claude')
      expect(item('claude').getAttribute('aria-current')).toBe('step')
      expect(item('claude').getAttribute('data-state')).toBe('current')
      expect(patches).toEqual([])
    })

    it('header has title, Step n of 4 and Close; footer has Back (quiet), Skip (ghost), Continue (primary)', async () => {
      mount('/?setup=browser')
      expect(screen.getByRole('heading', { name: SETUP_TEXT.title })).toBeTruthy()
      expect(screen.getByText(SETUP_TEXT.stepOf(2, 4))).toBeTruthy()
      const f = footer()
      const btn = (name: string): HTMLElement => within(f).getByRole('button', { name })
      expect(btn(SETUP_TEXT.back).getAttribute('data-variant')).toBe('ghost')
      expect(btn(SETUP_TEXT.skip).getAttribute('data-variant')).toBe('ghost')
      expect(btn(SETUP_TEXT.next).getAttribute('data-variant')).toBe('default')
      // Order: Back, Skip, Continue.
      expect(within(f).getAllByRole('button').map((b) => b.textContent)).toEqual([SETUP_TEXT.back, SETUP_TEXT.skip, SETUP_TEXT.next])
      await screen.findByText(SETUP_TEXT.browser.installed)
      fireEvent.click(screen.getByRole('button', { name: SETUP_TEXT.close }))
      await waitFor(() => expect(where).toBe('/'))
    })

    it('Claude: not tested with a request = a notice, Continue still works; a passing test clears it', async () => {
      mount('/?setup=claude')
      expect((await within(footer()).findByRole('status')).textContent).toBe(SETUP_TEXT.claude.untested)
      click(CONNECTION_TEXT.button.idle)
      await screen.findByText(/^Connection works/)
      expect(document.querySelector('[data-setup-notice]')).toBeNull()
    })

    it('Claude: a failed test says it can be fixed later and never blocks Continue', async () => {
      fakeServer({ connection: CONN_NOT_FOUND })
      mount('/?setup=claude')
      expect((await within(footer()).findByRole('status')).textContent).toBe(SETUP_TEXT.claude.failed)
      click(SETUP_TEXT.next)
      await waitFor(() => expect(heading()).toBe(SETUP_TEXT.steps.browser))
      expect(patches).toEqual([{ setup: { steps: { claude: 'done' } } }])
    })

    it('a new step takes focus on its heading; Tab wraps inside the dialog (focus trap)', async () => {
      mount('/?setup=basics', withSteps({ claude: 'done', browser: 'done', central: 'done' }))
      await waitFor(() => expect(document.activeElement?.hasAttribute('data-setup-heading')).toBe(true))
      const dialog = document.querySelector('[data-setup-dialog]') as HTMLElement
      const tabbables = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), a[href]')]
      tabbables.at(-1)!.focus()
      fireEvent.keyDown(tabbables.at(-1)!, { key: 'Tab' })
      expect(document.activeElement).toBe(tabbables[0])
      fireEvent.keyDown(tabbables[0]!, { key: 'Tab', shiftKey: true })
      expect(document.activeElement).toBe(tabbables.at(-1))
    })
  })
})
