/** @vitest-environment jsdom */
// The permission-mode control: the Central composer mode button (effective mode, icon + tooltip, scope, Danger confirm with
// confirmDanger in the payload, a confirm_required reply reopening the dialog, the stale-sessions line)
// and the Settings rows (all projects + This project, "Same as all projects" clears the override).
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, mergeSettings, type Settings } from '../shared/settings'
import { SettingsProvider } from './useSettings'
import { SettingsItemScopeProvider } from './settingsContext'
import { ApprovalModeChip, ApprovalModeFields } from './ApprovalModeControl'

beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
  Element.prototype.hasPointerCapture ??= () => false
  Element.prototype.scrollIntoView ??= () => undefined
})

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
let puts: Record<string, unknown>[]
let putReplies: Response[]
let stale: number
let sessionUrls: string[]

beforeEach(() => {
  puts = []
  putReplies = []
  stale = 0
  sessionUrls = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/settings' && init?.method === 'PUT') { puts.push(JSON.parse(String(init.body))); return putReplies.shift() ?? json(DEFAULT_SETTINGS) }
    if (url.startsWith('/api/settings/approval-sessions')) { sessionUrls.push(url); return json({ workspaceId: null, mode: 'auto', staleSessions: stale }) }
    return json({})
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const settings = (p: Partial<Settings> = {}): Settings => mergeSettings({ ...DEFAULT_SETTINGS, ...p })
const chip = (s: Settings, ws: string | null = 'w1') => render(<SettingsProvider value={s}><ApprovalModeChip workspaceId={ws} /></SettingsProvider>)
const trigger = () => screen.getByRole('button', { name: /^Permission mode/ })
const open = () => fireEvent.keyDown(trigger(), { key: 'Enter' })
const radio = (name: string) => screen.getByRole('menuitemradio', { name })

describe('ApprovalModeChip', () => {
  it('shows the EFFECTIVE mode of the open project, with Danger marked', () => {
    chip(settings({ projectApprovalLevels: { w1: 'never' } }))
    expect(trigger().textContent).toContain('Danger')
    expect(trigger().getAttribute('aria-label')).toBe('Permission mode: Danger (this project)')
    expect(trigger().closest('[data-mode]')?.getAttribute('data-mode')).toBe('never')
    cleanup()
    chip(settings(), 'w2')
    expect(trigger().getAttribute('aria-label')).toBe('Permission mode: Auto (all projects)')
  })

  it('ghost text button: icon per mode, no chevron; the tooltip states mode, scope and what it means', () => {
    const tipOf = (el: Element): string | null => {
      fireEvent.keyDown(document, { key: 'Tab' })
      fireEvent.focus(el)
      const t = document.querySelector('[role="tooltip"]')?.textContent ?? null
      fireEvent.blur(el)
      return t
    }
    chip(settings({ projectApprovalLevels: { w1: 'never' } }))
    expect(trigger().querySelector('.codicon-warning')).toBeTruthy()
    expect(trigger().querySelector('.codicon-chevron-down')).toBeNull()
    expect(tipOf(trigger())).toBe('Danger in this project: agents act without asking. Your Deny rules, spend limits and secret access still apply.')
    cleanup()
    chip(settings({ projectApprovalLevels: { w1: 'always' } }))
    expect(trigger().querySelector('.codicon-shield')).toBeTruthy()
    cleanup()
    chip(settings(), 'w2')
    expect(trigger().querySelector('.codicon-workspace-trusted')).toBeTruthy()
    expect(tipOf(trigger())).toBe('Auto in all projects: routine work runs on its own; actions that cannot be undone ask first.')
  })

  it('defaults to This project; "All projects" writes the global level', async () => {
    chip(settings())
    open()
    expect(radio('This project').getAttribute('aria-checked')).toBe('true')
    fireEvent.click(radio('Ask'))
    await waitFor(() => expect(puts).toEqual([{ projectApprovalLevels: { w1: 'always' } }]))
    open()
    fireEvent.click(radio('All projects'))
    fireEvent.click(radio('Ask'))
    await waitFor(() => expect(puts.at(-1)).toEqual({ agentApprovalLevel: 'always' }))
    expect(sessionUrls[0]).toBe('/api/settings/approval-sessions?workspaceId=w1')
  })

  it('without an open project there is no scope choice and the chip edits all projects', async () => {
    chip(settings(), null)
    open()
    expect(screen.queryByRole('menuitemradio', { name: 'This project' })).toBeNull()
    fireEvent.click(radio('Ask'))
    await waitFor(() => expect(puts).toEqual([{ agentApprovalLevel: 'always' }]))
  })

  it('Danger asks once; Cancel sends nothing, Confirm sends confirmDanger: true', async () => {
    chip(settings())
    open()
    fireEvent.click(radio('Danger'))
    expect(await screen.findByRole('alertdialog')).toBeTruthy()
    expect(screen.getByText(/run commands, edit and delete files and push without asking/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(puts).toEqual([])
    open()
    fireEvent.click(radio('Danger'))
    fireEvent.click(await screen.findByRole('button', { name: 'Switch to Danger' }))
    await waitFor(() => expect(puts).toEqual([{ projectApprovalLevels: { w1: 'never' }, confirmDanger: true }]))
  })

  it('a 400 confirm_required reopens the dialog and says so; never a silent failure', async () => {
    chip(settings())
    putReplies.push(json({ error: 'confirm_required', scopes: ['w1'] }, 400))
    open()
    fireEvent.click(radio('Danger'))
    fireEvent.click(await screen.findByRole('button', { name: 'Switch to Danger' }))
    await waitFor(() => expect(puts).toHaveLength(1))
    expect(await screen.findByRole('alertdialog')).toBeTruthy()
    // Behind the modal dialog (aria-hidden there), the chip's save line says why it did not switch.
    expect(document.querySelector('[data-save="error"]')?.textContent).toContain('Danger needs your confirmation')
  })

  it('a failed save shows the error with Retry, which sends it again', async () => {
    chip(settings())
    putReplies.push(json({ error: 'boom' }, 500))
    open()
    fireEvent.click(radio('Ask'))
    expect((await screen.findByRole('alert')).textContent).toContain('boom')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(puts).toHaveLength(2))
    expect(await screen.findByText(/Saved/)).toBeTruthy()
  })

  it('after a save, running terminal sessions on the old mode are counted in one line', async () => {
    stale = 2
    chip(settings())
    open()
    fireEvent.click(radio('Ask'))
    expect(await screen.findByText('2 running terminal sessions keep their old mode until restarted.')).toBeTruthy()
  })
})

describe('ApprovalModeFields (Settings › Claude › Permissions)', () => {
  const fields = (s: Settings, projectId?: string) =>
    render(<SettingsItemScopeProvider category="Claude" settings={s}><ApprovalModeFields settings={s} projectId={projectId} /></SettingsItemScopeProvider>)
  const all = () => screen.getByLabelText('How much may agents do on their own?') as HTMLSelectElement
  const project = () => screen.getByLabelText('This project') as HTMLSelectElement

  it('the all-projects row lists Ask, Auto, Danger and writes the global level', async () => {
    fields(settings())
    expect([...all().options].map((o) => o.textContent)).toEqual(['Ask', 'Auto', 'Danger'])
    expect(screen.queryByLabelText('This project')).toBeNull()
    fireEvent.change(all(), { target: { value: 'always' } })
    await waitFor(() => expect(puts).toEqual([{ agentApprovalLevel: 'always' }]))
  })

  it('"This project" shows the override; Same as all projects clears it; Danger confirms first', async () => {
    fields(settings({ projectApprovalLevels: { w1: 'always' } }), 'w1')
    expect(project().value).toBe('always')
    expect([...project().options][0]?.textContent).toBe('Same as all projects (Auto)')
    fireEvent.change(project(), { target: { value: 'inherit' } })
    await waitFor(() => expect(puts).toEqual([{ projectApprovalLevels: { w1: null } }]))
    fireEvent.change(project(), { target: { value: 'never' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Switch to Danger' }))
    await waitFor(() => expect(puts.at(-1)).toEqual({ projectApprovalLevels: { w1: 'never' }, confirmDanger: true }))
  })
})
