/** @vitest-environment jsdom */
// The real App under the URL contract (./appRoute), overlay by overlay: a reload restores the Settings
// section, the Central tab and the bottom-panel tab; Back/Forward toggle them; the app-wide events
// (OPEN_SETTINGS_EVENT, openCentralTab, a view opening = revealBottomView) write the URL; unknown values are dropped.
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { HARNESS_WS_ID, harnessNavigate, harnessUrl, installCanvasDom, mountCanvas, unmountCanvas } from './canvasHarness'
import { OPEN_SETTINGS_EVENT } from './claudeLauncher/claudeLaunch.client'
import { openCentralTab, reloadSideBarFromStorage, setSideBar } from './secondarySideBar.store'
import { setTimelineOpen } from './Timeline'
import { resetOutputStateForTest } from './output/outputCommands'
import { resetCapabilitiesCache } from './useCapabilities'

beforeAll(installCanvasDom)
beforeEach(() => {
  localStorage.clear()
  reloadSideBarFromStorage()
  resetOutputStateForTest()
  resetCapabilitiesCache()
})
afterEach(() => {
  unmountCanvas()
  setTimelineOpen(false)
  setSideBar({ open: false, view: 'chat' })
})

const BOARD = `/w/${HARNESS_WS_ID}` // test-only
const fx = (url: string, capabilitiesOn?: string[]) => ({ nodes: [], dirs: {}, url, capabilitiesOn })
const back = () => act(async () => { harnessNavigate!(-1) })
const forward = () => act(async () => { harnessNavigate!(1) })
const settingsNav = () => screen.getByRole('navigation', { name: 'Section settings' })
const currentSection = () => within(settingsNav()).getAllByRole('button').find((b) => b.getAttribute('aria-current') === 'true')?.textContent ?? ''

describe('Settings section in the URL', () => {
  it('a reload with `?settings=agent` opens Settings on Agent', async () => {
    await mountCanvas(fx(`${BOARD}?settings=agent`))
    await screen.findByRole('button', { name: 'Close settings' })
    expect(currentSection()).toContain('Agent')
  })

  it('picking a section replaces the URL entry', async () => {
    await mountCanvas(fx(BOARD))
    await act(async () => { harnessNavigate!(`${BOARD}?settings=agent`) }) // a link pushes Settings
    await screen.findByRole('button', { name: 'Close settings' })
    fireEvent.click(within(settingsNav()).getByRole('button', { name: 'Memory' }))
    await waitFor(() => expect(harnessUrl).toBe(`${BOARD}?settings=memory`))
    await back() // the section change replaced the entry: Back leaves Settings, it does not step sections
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Close settings' })).toBeNull())
  })

  it('OPEN_SETTINGS_EVENT writes its section (legacy ids mapped); reopening lands on the last section', async () => {
    await mountCanvas(fx(BOARD))
    act(() => { window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { detail: { section: 'env' } })) })
    await waitFor(() => expect(harnessUrl).toBe(`${BOARD}?settings=capabilities`))
    fireEvent.click(await screen.findByRole('button', { name: 'Close settings' }))
    await waitFor(() => expect(harnessUrl).toBe(BOARD))
    fireEvent.click(screen.getAllByRole('button', { name: /^Settings/ })[0])
    await waitFor(() => expect(harnessUrl).toBe(`${BOARD}?settings=capabilities`))
  })

  it('Back closes Settings and Forward reopens it on the same section', async () => {
    await mountCanvas(fx(BOARD))
    act(() => { window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { detail: { section: 'rules' } })) })
    await screen.findByRole('button', { name: 'Close settings' })
    await back()
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Close settings' })).toBeNull())
    await forward()
    await screen.findByRole('button', { name: 'Close settings' })
    expect(currentSection()).toContain('Rules')
  })
})

describe('Central tab in the URL', () => {
  const memoryTab = () => screen.findByRole('tab', { name: 'Memory' })

  it('a reload with `?ctab=memory` shows the Central side bar on Memory', async () => {
    await mountCanvas(fx(`${BOARD}?ctab=memory`, ['central']))
    await waitFor(async () => expect((await memoryTab()).getAttribute('aria-selected')).toBe('true'))
    expect(screen.getByRole('tab', { name: 'Control' }).getAttribute('aria-selected')).toBe('true')
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Agents' }))
    await waitFor(() => expect(harnessUrl).toBe(`${BOARD}?ctab=agents`))
  })

  it('openCentralTab writes `?ctab=`; Back closes the side bar, Forward reopens it', async () => {
    await mountCanvas(fx(BOARD, ['central']))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Toggle Secondary Side Bar' })).not.toBeNull())
    act(() => openCentralTab('agents'))
    await waitFor(() => expect(harnessUrl).toBe(`${BOARD}?ctab=agents`))
    await waitFor(async () => expect((await screen.findByRole('tab', { name: 'Agents' })).getAttribute('aria-selected')).toBe('true'))
    await back()
    await waitFor(() => expect(screen.queryByRole('tab', { name: 'Control' })).toBeNull())
    await forward()
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Control' }).getAttribute('aria-selected')).toBe('true'))
  })

  it('leaving Central (switch to Chat) drops `?ctab=`', async () => {
    await mountCanvas(fx(`${BOARD}?ctab=skills`, ['central']))
    await screen.findByRole('tab', { name: 'Control' })
    act(() => setSideBar({ view: 'chat' }))
    await waitFor(() => expect(harnessUrl).toBe(BOARD))
  })
})

describe('bottom panel tab in the URL', () => {
  const tab = (name: string) => screen.queryByRole('tab', { name: new RegExp(`^${name}`) })

  it('a reload with `?panel=problems` opens the panel on Problems', async () => {
    await mountCanvas(fx(`${BOARD}?panel=problems`))
    await waitFor(() => expect(tab('Problems')?.getAttribute('aria-selected')).toBe('true'))
  })

  it('revealBottomView writes `?panel=`; Back closes the panel, Forward reopens it', async () => {
    await mountCanvas(fx(BOARD))
    act(() => setTimelineOpen(true))
    await waitFor(() => expect(harnessUrl).toBe(`${BOARD}?panel=activity`))
    await back()
    await waitFor(() => expect(tab('Activity')).toBeNull())
    await forward()
    await waitFor(() => expect(tab('Activity')?.getAttribute('aria-selected')).toBe('true'))
  })

  it('closing the shown tab moves the URL to the next one, closing the last drops it', async () => {
    await mountCanvas(fx(`${BOARD}?panel=problems`))
    await waitFor(() => expect(tab('Problems')).not.toBeNull())
    act(() => setTimelineOpen(true))
    await waitFor(() => expect(harnessUrl).toBe(`${BOARD}?panel=activity`))
    act(() => setTimelineOpen(false))
    await waitFor(() => expect(harnessUrl).toBe(`${BOARD}?panel=problems`))
  })
})

describe('unknown overlay values', () => {
  it('are dropped from the URL and open nothing', async () => {
    await mountCanvas(fx(`${BOARD}?settings=zzz&ctab=approvals&panel=nope`))
    await waitFor(() => expect(harnessUrl).toBe(BOARD))
    expect(screen.queryByRole('button', { name: 'Close settings' })).toBeNull()
    expect(screen.queryByRole('tab', { name: /^Problems/ })).toBeNull()
  })
})
