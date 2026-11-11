/** @vitest-environment jsdom */
// The real App with a Settings deep link to one setting (`?settings=<section>&field=<id>`): a reload
// keeps the field and reveals it, a link writes it (push: Back closes, Forward reopens on it), and a
// plain section change replaces the entry without it.
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { HARNESS_WS_ID, harnessNavigate, harnessUrl, installCanvasDom, mountCanvas, unmountCanvas } from './canvasHarness'
import { openSettingsAt } from './settings.link'
import { REVEAL_CLASS } from './settingsPanel.reveal'
import { reloadSideBarFromStorage } from './secondarySideBar.store'
import { resetCapabilitiesCache } from './useCapabilities'

const BOARD = `/w/${HARNESS_WS_ID}` // test-only
const fx = (url: string) => ({ nodes: [], dirs: {}, url })
const back = () => act(async () => { harnessNavigate!(-1) })
const forward = () => act(async () => { harnessNavigate!(1) })
const field = (id: string) => document.querySelector<HTMLElement>(`[data-field="${id}"]`)
let scrolled: Element[]

beforeAll(installCanvasDom)
beforeEach(() => {
  localStorage.clear()
  reloadSideBarFromStorage()
  resetCapabilitiesCache()
  scrolled = []
  Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this) }
})
afterEach(() => { unmountCanvas(); delete (Element.prototype as Partial<Element>).scrollIntoView })

describe('Settings field in the URL', () => {
  it('a reload with `&field=` keeps it and reveals the setting', async () => {
    await mountCanvas(fx(`${BOARD}?settings=agent&field=skipApprovals`))
    await waitFor(() => expect(scrolled).toContain(field('skipApprovals')))
    const el = field('skipApprovals')!
    expect(el.classList.contains(REVEAL_CLASS)).toBe(true)
    expect(el.contains(document.activeElement)).toBe(true)
    expect(harnessUrl).toBe(`${BOARD}?settings=agent&field=skipApprovals`)
  })

  it('an unknown field is dropped from the URL; the section still opens', async () => {
    await mountCanvas(fx(`${BOARD}?settings=agent&field=nope`))
    await screen.findByRole('button', { name: 'Close settings' })
    await waitFor(() => expect(harnessUrl).toBe(`${BOARD}?settings=agent`))
  })

  it('openSettingsAt pushes section + field; Back closes, Forward reopens on the same field', async () => {
    await mountCanvas(fx(BOARD))
    act(() => openSettingsAt('agent', 'skipApprovals'))
    await waitFor(() => expect(harnessUrl).toBe(`${BOARD}?settings=agent&field=skipApprovals`))
    await waitFor(() => expect(scrolled).toContain(field('skipApprovals')))
    await back()
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Close settings' })).toBeNull())
    expect(harnessUrl).toBe(BOARD)
    scrolled = []
    await forward()
    await waitFor(() => expect(scrolled).toContain(field('skipApprovals')))
    expect(harnessUrl).toBe(`${BOARD}?settings=agent&field=skipApprovals`)
  })

  it('picking another section replaces the entry and clears the field', async () => {
    await mountCanvas(fx(BOARD))
    act(() => openSettingsAt('agent', 'skipApprovals'))
    await screen.findByRole('button', { name: 'Close settings' })
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Section settings' })).getByRole('button', { name: 'Memory' }))
    await waitFor(() => expect(harnessUrl).toBe(`${BOARD}?settings=memory`))
    await back()
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Close settings' })).toBeNull())
  })
})
