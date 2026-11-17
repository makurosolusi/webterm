/** @vitest-environment jsdom */
// Command "Central: Cycle Permission Mode": Ask → Auto → Bypass → Ask through the mounted chip; the
// move to Bypass opens the chip's confirmation (never skips it). No default chord: ⌘⇧M / Ctrl+Shift+M
// is reserved by the browser, so it is bound only by the user, and that binding dispatches it.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, mergeSettings, type Settings } from '../shared/settings'
import { SettingsProvider } from './useSettings'
import { ApprovalModeChip } from './ApprovalModeControl'
import { CYCLE_APPROVAL_MODE_COMMAND, nextApprovalLevel } from './approvalMode.state'
import { listCommands, useCommandKeybindings } from './commandRegistry'
import { connectKeybindings } from './keybindings.store'

beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
})

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
let puts: Record<string, unknown>[]
beforeEach(() => {
  puts = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/settings' && init?.method === 'PUT') { puts.push(JSON.parse(String(init.body))); return json(DEFAULT_SETTINGS) }
    if (url.startsWith('/api/settings/approval-sessions')) return json({ staleSessions: 0 })
    return json({})
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); connectKeybindings({}, null) })

const settings = (p: Partial<Settings> = {}): Settings => mergeSettings({ ...DEFAULT_SETTINGS, ...p })
function Keys() { useCommandKeybindings(); return null }
const chip = (s: Settings) => render(<SettingsProvider value={s}><Keys /><ApprovalModeChip workspaceId="w1" /></SettingsProvider>)
const cycle = (): void => act(() => listCommands().find((c) => c.id === CYCLE_APPROVAL_MODE_COMMAND.id)!.run!())

describe('cycle permission mode command', () => {
  it('orders Ask → Auto → Bypass → Ask', () => {
    expect(['always', 'risky', 'never'].map((l) => nextApprovalLevel(l as 'always'))).toEqual(['risky', 'never', 'always'])
  })

  it('is registered, labelled, and left unbound (the browser owns ⌘⇧M / Ctrl+Shift+M)', () => {
    const cmd = listCommands().find((c) => c.id === 'permissions.cycleMode')
    expect(cmd?.label).toBe('Central: Cycle Permission Mode (Ask, Auto, Bypass)')
    expect(cmd?.defaultKey).toBeUndefined()
  })

  it('Ask → Auto saves straight away', async () => {
    chip(settings({ projectApprovalLevels: { w1: 'always' } }))
    cycle()
    await waitFor(() => expect(puts).toEqual([{ projectApprovalLevels: { w1: 'risky' } }]))
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('Auto → Bypass opens the confirmation: Cancel sends nothing, Switch sends confirmDanger', async () => {
    chip(settings({ projectApprovalLevels: { w1: 'risky' } }))
    cycle()
    expect(await screen.findByRole('alertdialog')).toBeTruthy()
    expect(puts).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(puts).toEqual([])
    cycle()
    fireEvent.click(await screen.findByRole('button', { name: 'Switch to Bypass' }))
    await waitFor(() => expect(puts).toEqual([{ projectApprovalLevels: { w1: 'never' }, confirmDanger: true }]))
  })

  it('a user binding dispatches it, and still goes through the Bypass confirmation', async () => {
    connectKeybindings({ 'permissions.cycleMode': 'Mod+Alt+M' }, null)
    chip(settings({ projectApprovalLevels: { w1: 'risky' } }))
    fireEvent.keyDown(document.body, { key: 'm', code: 'KeyM', ctrlKey: true, altKey: true })
    expect(await screen.findByRole('alertdialog')).toBeTruthy()
    expect(puts).toEqual([])
  })

  it('does nothing once no chip is mounted', () => {
    const { unmount } = chip(settings())
    unmount()
    cycle()
    expect(puts).toEqual([])
  })
})
