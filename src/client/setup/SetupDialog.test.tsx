/** @vitest-environment jsdom */
// The wizard shell: hidden without ?setup=, resumes at the first unfinished step, ?setup=<step> opens
// there, Skip / Back / Continue PATCH progress per step, Escape keeps progress, Finish sets completedAt.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type Settings } from '../../shared/settings'
import { applySettingsPatch, type SettingsPatch } from '../../shared/settings.patch'
import { AppRouteSync } from '../appRoute'
import { registerCommands } from '../commandRegistry'
import { resetCapabilitiesCache } from '../useCapabilities'
import SetupDialog from './SetupDialog'
import { fakeServer } from './setup.fakeServer'
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
})
