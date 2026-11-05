/** @vitest-environment jsdom */
// Launch profiles card: list/add/edit/delete, default + Central pickers, inline fix, Test stages.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { DEFAULT_SETTINGS, type Settings } from '../../shared/settings'
import { ClaudeLaunchProfilesCard } from './ClaudeLaunchProfilesCard'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function Harness({ initial, spy }: { initial: Partial<Settings>; spy: (p: Partial<Settings>) => void }): React.JSX.Element {
  const [s, setS] = useState<Settings>({ ...DEFAULT_SETTINGS, ...initial })
  return <ClaudeLaunchProfilesCard settings={s} onChange={(p) => { spy(p); setS((cur) => ({ ...cur, ...p })) }} />
}
const MALIK = { id: 'm', name: 'Malik', command: 'envman -e claude:malik-opus -- claude' }
const setup = (initial: Partial<Settings> = {}) => {
  const spy = vi.fn()
  render(<Harness initial={initial} spy={spy} />)
  return spy
}
const row = (name: string) => screen.getByRole('region', { name })

describe('ClaudeLaunchProfilesCard', () => {
  it('Default is built in: read-only, no Delete', () => {
    setup()
    const d = row('Default')
    expect(within(d).getByText('Built in')).toBeTruthy()
    expect(within(d).queryByRole('button', { name: 'Delete' })).toBeNull()
    expect((within(d).getByLabelText('Default Launch command') as HTMLInputElement).disabled).toBe(true)
  })

  it('add, edit, then delete a profile; deleting the default resets the pointers', () => {
    const spy = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Add profile' }))
    const added = row('Profile 1')
    fireEvent.change(within(added).getByLabelText('Profile 1 Launch command'), { target: { value: 'envman -e a:b --' } })
    expect(within(added).getByText('envman -e a:b -- claude')).toBeTruthy() // "Runs:" preview
    const id = (spy.mock.calls.at(-1)?.[0] as Settings).claudeLaunchProfiles[0]!.id
    fireEvent.change(screen.getByLabelText('Default for new Claude agents'), { target: { value: id } })
    fireEvent.change(screen.getByLabelText('Central Agent uses'), { target: { value: id } })
    fireEvent.click(within(row('Profile 1')).getByRole('button', { name: 'Delete' }))
    expect(spy).toHaveBeenLastCalledWith({ claudeLaunchProfiles: [], defaultClaudeProfileId: 'default', centralClaudeProfileId: '' })
  })

  it('shows normalisation warnings inline and Apply fix rewrites the command', () => {
    const spy = setup({ claudeLaunchProfiles: [{ id: 'w', name: 'W', command: 'envman -e x claude claude' }] })
    const w = row('W')
    expect(within(w).getByText('envman needs "--" before the command it runs.')).toBeTruthy()
    expect(within(w).getByText('Removed a repeated "claude".')).toBeTruthy()
    fireEvent.click(within(w).getByRole('button', { name: 'Apply fix' }))
    expect(spy).toHaveBeenLastCalledWith({ claudeLaunchProfiles: [{ id: 'w', name: 'W', command: 'envman -e x -- claude' }] })
    expect(within(row('W')).queryByRole('button', { name: 'Apply fix' })).toBeNull()
  })

  it('Test shows each stage with a check or a cross and the fix hint', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      ok: false, profile: { id: 'm', name: 'Malik' }, failed: 'wrapper_not_found', warnings: [],
      steps: [{ stage: 'wrapper', ok: false, message: 'envman not found on PATH', hint: 'Install it on the server, or fix the command in the launch profile.' }],
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    setup({ claudeLaunchProfiles: [MALIK] })
    fireEvent.click(within(row('Malik')).getByRole('button', { name: 'Test' }))
    const result = await screen.findByRole('list', { name: 'Launch test result' })
    expect(result.textContent).toContain('✗')
    expect(result.textContent).toContain('envman not found on PATH')
    expect(result.textContent).toContain('Install it on the server')
    expect(JSON.parse((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ profileId: 'm' })
  })

  it('a failed Test request is reported, not swallowed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'unknown_profile' }), { status: 404 })))
    setup({ claudeLaunchProfiles: [MALIK] })
    fireEvent.click(within(row('Malik')).getByRole('button', { name: 'Test' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/unknown_profile/))
  })
})
