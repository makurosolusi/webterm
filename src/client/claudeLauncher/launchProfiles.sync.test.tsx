/** @vitest-environment jsdom */
// The data-loss bug end to end: the setup wizard's provider form saves an envman command as a launch
// profile straight to the server; Settings › Agent (fed by useSettings, loaded once at start) must show it
// without a page reload, and editing another profile there must not erase it. The fake server runs the
// real store logic (`nextSettingsDocument`), so the server's merge-by-id is part of what is tested.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextSettingsDocument, parseStored, SettingsConflictError } from '../../server/settingsStore'
import { ClaudeProviderCard, PROVIDER_TEXT } from '../ClaudeProviderCard'
import { COMMAND_TEXT } from '../ClaudeProviderCommand'
import { flushSettingsSaves, useSettings } from '../useSettings'
import { SettingsItemScopeProvider } from '../settingsContext'
import { ClaudeLaunchProfilesCard, PROFILES_TEXT } from './ClaudeLaunchProfilesCard'

const CMD = 'envman -e claude:malik-opus -- claude' // test-only
const WORK = { id: 'w', name: 'Work', command: 'claude' } // test-only

function serve(): { stored: () => string | null } {
  let stored: string | null = JSON.stringify({ claudeLaunchProfiles: [WORK] })
  let provider: Record<string, unknown> = { mode: 'login', secretSet: false, ready: true }
  const json = (o: unknown, status = 200): Response => new Response(JSON.stringify(o), { status })
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET'
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined
    if (url.startsWith('/api/settings')) {
      if (method !== 'PUT') return json(parseStored(stored))
      try {
        const next = nextSettingsDocument(stored, body, { providerProfileId: provider.profileId as string | undefined })
        stored = JSON.stringify(next.doc)
        return json(next.settings)
      } catch (e) {
        if (e instanceof SettingsConflictError) return json({ error: 'profile_in_use', profileId: e.profileId, reason: e.reason }, 409)
        throw e
      }
    }
    if (url === '/api/claude-provider/detect') return json({ wrappers: [] })
    if (method === 'PUT' && body.mode === 'command') {
      const profile = parseStored(stored).claudeLaunchProfiles.find((p) => p.id === body.profileId)
      provider = { mode: 'command', profileId: body.profileId, profile, secretSet: false, ready: !!profile }
    }
    return json({ provider, lastTest: null, restartNeeded: 0 })
  }))
  return { stored: () => stored }
}

/** The app: the wizard's provider form (no profile callback, like setup.claude.tsx) beside Settings › Agent. */
function App(): React.JSX.Element {
  const { settings, update, hydrated } = useSettings()
  return (
    <>
      <ClaudeProviderCard />
      {hydrated ? <ClaudeLaunchProfilesCard settings={settings} onChange={update} /> : null}
    </>
  )
}

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('launch profiles written by the setup wizard', () => {
  it('appear in Settings › Agent without a reload, and editing another profile keeps them', async () => {
    const server = serve()
    render(<App />)
    await screen.findByRole('region', { name: 'Work' })
    fireEvent.click(await screen.findByRole('button', { name: PROVIDER_TEXT.modes.command }))
    fireEvent.change(await screen.findByLabelText(COMMAND_TEXT.command), { target: { value: CMD } })
    fireEvent.click(screen.getByRole('button', { name: COMMAND_TEXT.save }))
    const envman = await screen.findByRole('region', { name: 'envman: claude:malik-opus' })
    expect(envman).toBeTruthy()

    // Edit Work in Settings › Agent; the save carries only Work, the envman profile stays stored.
    fireEvent.click(within(screen.getByRole('region', { name: 'Work' })).getByRole('button', { name: 'Edit' }))
    fireEvent.change(within(screen.getByRole('form')).getByLabelText('Launch command'), { target: { value: 'claude --model opus' } })
    fireEvent.click(within(screen.getByRole('form')).getByRole('button', { name: 'Save' }))
    await act(() => flushSettingsSaves())
    const stored = parseStored(server.stored()).claudeLaunchProfiles
    expect(stored.map((p) => p.command)).toEqual(['claude --model opus', CMD])

    // The provider runs the envman profile: Delete is refused and says why, the profile stays.
    fireEvent.click(within(screen.getByRole('region', { name: 'envman: claude:malik-opus' })).getByRole('button', { name: 'Delete' }))
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(within(screen.getByRole('region', { name: 'envman: claude:malik-opus' })).getByRole('alert').textContent).toMatch(/Claude provider runs/))
    expect(parseStored(server.stored()).claudeLaunchProfiles).toHaveLength(2)
  })

  it('Reset Setting on the list, refused because the provider runs one: the reason shows inline and the profiles stay', async () => {
    const server = serve()
    function Scoped(): React.JSX.Element {
      const { settings, update, hydrated } = useSettings()
      return (
        <>
          <ClaudeProviderCard />
          {hydrated ? <SettingsItemScopeProvider category="Claude" settings={settings} onChange={update}><ClaudeLaunchProfilesCard settings={settings} onChange={update} /></SettingsItemScopeProvider> : null}
        </>
      )
    }
    render(<Scoped />)
    await screen.findByRole('region', { name: 'Work' })
    fireEvent.click(await screen.findByRole('button', { name: PROVIDER_TEXT.modes.command }))
    fireEvent.change(await screen.findByLabelText(COMMAND_TEXT.command), { target: { value: CMD } })
    fireEvent.click(screen.getByRole('button', { name: COMMAND_TEXT.save }))
    await screen.findByRole('region', { name: 'envman: claude:malik-opus' })
    fireEvent.click(screen.getByRole('button', { name: 'Reset Setting: Claude launch profiles' }))
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Reset' }))
    await act(() => flushSettingsSaves().catch(() => undefined))
    const field = document.querySelector('[data-field="claudeLaunchProfiles"]') as HTMLElement
    await waitFor(() => expect(within(field).getByText(/^Could not save:/).textContent)
      .toBe(`Could not save: ${PROFILES_TEXT.inUse('envman: claude:malik-opus', 'provider')}`))
    expect(parseStored(server.stored()).claudeLaunchProfiles).toHaveLength(2)
    expect(await screen.findByRole('region', { name: 'envman: claude:malik-opus' })).toBeTruthy()
  })
})
