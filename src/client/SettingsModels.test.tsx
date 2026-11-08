/** @vitest-environment jsdom */
// Settings › Agent › Models: ladder defaults table and per-workspace overrides (entry patches).
// The daily spending limit moved to Settings › Central Agent (CentralSettingsSection.test.tsx).
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { DEFAULT_SETTINGS, type Settings } from '../shared/settings'
import { applySettingsPatch, type SettingsPatch } from '../shared/settings.patch'
import { SettingsItemScopeProvider } from './settingsContext'
import { ModelsSettings } from './SettingsModels'

const WORKSPACES = [{ id: 'w1', name: 'Alpha' }, { id: 'w2', name: 'Beta' }] // test-only

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
    if (url === '/api/workspaces') return ok(WORKSPACES)
    return new Response('{}', { status: 404 })
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function Harness({ initial = {}, spy }: { initial?: Partial<Settings>; spy?: (p: SettingsPatch) => void }): React.JSX.Element {
  const [s, setS] = useState<Settings>({ ...DEFAULT_SETTINGS, ...initial })
  const onChange = (p: SettingsPatch): void => { spy?.(p); setS((cur) => applySettingsPatch(cur, p)) }
  return (
    <SettingsItemScopeProvider category="Agent" settings={s} onChange={onChange}>
      <ModelsSettings settings={s} onChange={onChange} />
      <output data-testid="state">{JSON.stringify(s.projectModels)}</output>
    </SettingsItemScopeProvider>
  )
}
const state = () => JSON.parse(screen.getByTestId('state').textContent ?? '{}')
const select = (name: string) => screen.getByRole('combobox', { name }) as HTMLSelectElement

describe('Settings › Models', () => {
  it('shows the ladder defaults table', () => {
    render(<Harness />)
    const rows = within(screen.getByRole('table', { name: 'Model ladder defaults' })).getAllByRole('row').map((r) => r.textContent)
    expect(rows).toEqual([
      'ModelEffortUsed for',
      'HaikulowHelpers and quick exploration',
      'SonnetmediumDefault: Central, routines, reviews, workers',
      'OpushighPlanners and complex tasks',
      'FablexhighOnly when you ask for it',
    ])
  })

  it('adds a workspace override as one entry patch, edits it, and removes it with null', async () => {
    const spy = vi.fn()
    render(<Harness spy={spy} />)
    await waitFor(() => expect(select('Workspace').options.length).toBe(3))
    const add = screen.getByRole('button', { name: 'Add override' }) as HTMLButtonElement
    fireEvent.change(select('Workspace'), { target: { value: 'w2' } })
    expect(add.disabled).toBe(true) // both Auto = nothing to pin
    fireEvent.change(select('New override model'), { target: { value: 'opus' } })
    fireEvent.click(add)
    expect(spy).toHaveBeenLastCalledWith({ projectModels: { w2: { model: 'opus' } } })
    expect(state()).toEqual({ w2: { model: 'opus' } })
    expect(Array.from(select('Workspace').options).map((o) => o.value)).toEqual(['', 'w1']) // Beta has one now

    fireEvent.change(select('Effort for Beta'), { target: { value: 'high' } })
    expect(state()).toEqual({ w2: { model: 'opus', effort: 'high' } })
    fireEvent.change(select('Model for Beta'), { target: { value: '' } })
    fireEvent.change(select('Effort for Beta'), { target: { value: '' } })
    expect(spy).toHaveBeenLastCalledWith({ projectModels: { w2: null } }) // both Auto = back to the ladder
    expect(state()).toEqual({})
  })

  it('Remove deletes only that entry; Reset Setting asks first and clears every entry', async () => {
    render(<Harness initial={{ projectModels: { w1: { model: 'haiku' }, w2: { effort: 'max' } } }} />)
    await screen.findByText('Alpha')
    fireEvent.click(within(screen.getByLabelText('Override for Alpha')).getByRole('button', { name: 'Remove' }))
    expect(state()).toEqual({ w2: { effort: 'max' } })
    fireEvent.click(screen.getByRole('button', { name: 'Reset Setting: Per-workspace model' }))
    expect(screen.getByRole('alertdialog').textContent).toContain('1 entry will be removed')
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }))
    expect(state()).toEqual({})
  })
})
