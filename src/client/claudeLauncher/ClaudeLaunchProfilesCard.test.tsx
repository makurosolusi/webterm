/** @vitest-environment jsdom */
// Launch profiles card: list, Add/Edit editor (focus, templates, preview, validation, Apply fix),
// Delete with confirm, one-click use after Save, Test stages, and the Modified marker.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { DEFAULT_SETTINGS, mergeSettings, type Settings } from '../../shared/settings'
import { resolveProfileLaunch } from '../../shared/claudeLaunch/claudeLaunch.profiles'
import { joinArgv } from '../../shared/claudeLaunch/shellQuote'
import { applySettingsPatch, type SettingsPatch } from '../../shared/settings.patch'
import { SettingsItemScopeProvider, isModified, resetPatch } from '../settingsContext'
import { resetConfirmTitle } from '../SettingsFields'
import { ClaudeLaunchProfilesCard, PROFILES_TEXT } from './ClaudeLaunchProfilesCard'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function Harness({ initial, spy }: { initial: Partial<Settings>; spy: (p: Partial<Settings>) => void }): React.JSX.Element {
  const [s, setS] = useState<Settings>({ ...DEFAULT_SETTINGS, ...initial })
  const onChange = (p: SettingsPatch): void => { spy(p as Partial<Settings>); setS((cur) => applySettingsPatch(cur, p)) }
  return (
    <SettingsItemScopeProvider category="Agent" settings={s} onChange={onChange}>
      <button type="button">outside</button>
      <ClaudeLaunchProfilesCard settings={s} onChange={onChange} />
    </SettingsItemScopeProvider>
  )
}
const MALIK = { id: 'm', name: 'Malik', command: 'envman -e claude:malik-opus -- claude' } // test-only
const setup = (initial: Partial<Settings> = {}) => {
  const spy = vi.fn()
  render(<Harness initial={initial} spy={spy} />)
  return spy
}
const row = (name: string) => screen.getByRole('region', { name })
const editor = () => screen.getByRole('form')
const lastProfiles = (spy: ReturnType<typeof vi.fn>) =>
  [...spy.mock.calls].reverse().map((c) => (c[0] as Partial<Settings>).claudeLaunchProfiles).find(Boolean)!
const openAdd = () => fireEvent.click(screen.getByRole('button', { name: 'Add profile' }))
const type = (label: string, value: string) => fireEvent.change(within(editor()).getByLabelText(label), { target: { value } })

describe('ClaudeLaunchProfilesCard', () => {
  it('lists the built-in Default read-only with Test, plus the empty-state line', () => {
    setup()
    const d = row('Default')
    // Root cause of the old "Add profile only shows a gear": rows were .st-card, which settings CSS hides
    // when it holds no .st-field (`.st-card:not(:has(.st-field))`), so every profile row was invisible.
    expect(document.querySelector('[data-card="claude-launch-profiles"] .st-card')).toBeNull()
    expect(within(d).getByText('Built in')).toBeTruthy()
    expect(within(d).getByText('claude')).toBeTruthy()
    expect(within(d).getByText('Default for new agents')).toBeTruthy()
    expect(within(d).getByText('Central')).toBeTruthy()
    expect(within(d).getByRole('button', { name: 'Test' })).toBeTruthy()
    expect(within(d).queryByRole('button', { name: 'Edit' })).toBeNull()
    expect(within(d).queryByRole('button', { name: 'Delete' })).toBeNull()
    expect(screen.getByText(/A profile is a named command that starts Claude/)).toBeTruthy()
  })

  it('Add opens the editor with focus in Name; Escape cancels and focus returns to Add', () => {
    const spy = setup()
    openAdd()
    expect(document.activeElement).toBe(within(editor()).getByLabelText('Name'))
    expect((within(editor()).getByLabelText('Launch command') as HTMLInputElement).placeholder).toBe('your-wrapper … --')
    fireEvent.keyDown(within(editor()).getByLabelText('Name'), { key: 'Escape' })
    expect(screen.queryByRole('form')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add profile' }))
    expect(spy).not.toHaveBeenCalled()
  })

  it('templates fill the command and select the part to type over', () => {
    setup()
    openAdd()
    const cmd = within(editor()).getByLabelText('Launch command') as HTMLInputElement
    const pick = (name: string): void => {
      fireEvent.click(within(editor()).getByRole('button', { name: 'Show suggestions' }))
      fireEvent.click(within(editor()).getByRole('option', { name: new RegExp(name) }))
    }
    pick('Wrapper ending in --')
    expect(cmd.value).toBe('<wrapper> --')
    expect(document.activeElement).toBe(cmd)
    expect(cmd.value.slice(cmd.selectionStart!, cmd.selectionEnd!)).toBe('<wrapper>')
    pick('Custom claude path')
    expect(cmd.value).toBe('/path/to/claude')
    pick('Extra flags')
    expect(cmd.value).toBe('claude --model opus')
    expect(cmd.value.slice(cmd.selectionStart!, cmd.selectionEnd!)).toBe('opus')
  })

  it('the live preview is what the shared resolver (the server\'s) runs', () => {
    setup()
    openAdd()
    for (const command of ['envman -e a:b --', '$ envman -e x claude claude', "op run -- claude --model 'opus 4'"]) {
      type('Launch command', command)
      const expected = joinArgv(resolveProfileLaunch({ claudeLaunchProfiles: [{ id: 'x', name: 'x', command }], defaultClaudeProfileId: 'x', centralClaudeProfileId: '' }).argv)
      expect(screen.getByTestId('cp-preview').textContent).toBe(expected)
    }
    expect(screen.getByTestId('cp-preview').textContent).toBe("op run -- claude --model 'opus 4'")
  })

  it('a typo shows its warning and Apply fix rewrites the draft', () => {
    setup()
    openAdd()
    type('Launch command', 'envman -e x claude claude')
    expect(within(editor()).getByText('envman needs "--" before the command it runs.')).toBeTruthy()
    fireEvent.click(within(editor()).getByRole('button', { name: 'Apply fix' }))
    expect((within(editor()).getByLabelText('Launch command') as HTMLInputElement).value).toBe('envman -e x -- claude')
    expect(within(editor()).queryByRole('button', { name: 'Apply fix' })).toBeNull()
  })

  it('validation: Save stays disabled for an empty name, a duplicate name, an empty command, an open quote or a left template', () => {
    setup({ claudeLaunchProfiles: [MALIK] })
    openAdd()
    const save = () => within(editor()).getByRole('button', { name: 'Save' }) as HTMLButtonElement
    expect(save().disabled).toBe(true)
    type('Name', ' malik ')
    type('Launch command', 'envman -e a --')
    fireEvent.blur(within(editor()).getByLabelText('Name'))
    expect(within(editor()).getByText('A profile with this name already exists.')).toBeTruthy()
    expect(save().disabled).toBe(true)
    type('Name', 'default')
    expect(save().disabled).toBe(true)
    type('Name', 'Work')
    expect(save().disabled).toBe(false)
    type('Launch command', "claude --model 'opus")
    fireEvent.blur(within(editor()).getByLabelText('Launch command'))
    expect(within(editor()).getByText('A quote is not closed.')).toBeTruthy()
    expect(save().disabled).toBe(true)
    type('Launch command', '<wrapper> --')
    expect(within(editor()).getByText('Replace <wrapper> with your own value.')).toBeTruthy()
    type('Launch command', '   ')
    expect(within(editor()).getByText('Enter the command that starts Claude.')).toBeTruthy()
    expect(save().disabled).toBe(true)
  })

  it('Save stores the profile through onChange, the row appears, and Use for Central sets that pointer (agents follow the Connection)', () => {
    const spy = setup()
    openAdd()
    type('Name', '  Work  ')
    type('Launch command', 'envman -e claude:work --')
    fireEvent.click(within(editor()).getByRole('button', { name: 'Save' }))
    const [saved] = lastProfiles(spy)
    expect(saved).toMatchObject({ name: 'Work', command: 'envman -e claude:work --' })
    const r = row('Work')
    expect(within(r).getByText('envman -e claude:work -- claude')).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add profile' }))
    fireEvent.click(within(r).getByRole('button', { name: 'Use for Central' }))
    expect(spy).toHaveBeenLastCalledWith({ centralClaudeProfileId: saved!.id })
    expect(within(row('Work')).getByText('Central')).toBeTruthy()
    expect(within(row('Default')).queryByText('Central')).toBeNull()
    expect(within(row('Work')).queryByRole('button', { name: 'Use for new Claude agents' })).toBeNull()
  })

  it('badges come from the server truth when given (command mode), not the stored default', () => {
    const effective = {
      agents: { profileId: 'm', name: 'Malik', command: MALIK.command },
      central: { profileId: 'm', name: 'Malik', command: MALIK.command, source: 'default' as const },
      credential: 'command' as const, deviations: [],
    }
    render(<ClaudeLaunchProfilesCard settings={{ ...DEFAULT_SETTINGS, claudeLaunchProfiles: [MALIK] }} onChange={vi.fn()} effective={effective} />)
    expect(within(row('Malik')).getByText('Default for new agents')).toBeTruthy()
    expect(within(row('Malik')).getByText('Central')).toBeTruthy()
    expect(within(row('Default')).queryByText('Default for new agents')).toBeNull()
  })

  it('Edit reuses the editor prefilled; Delete asks first, then resets pointers', async () => {
    const spy = setup({ claudeLaunchProfiles: [MALIK], defaultClaudeProfileId: 'm', centralClaudeProfileId: 'm' })
    fireEvent.click(within(row('Malik')).getByRole('button', { name: 'Edit' }))
    expect((within(editor()).getByLabelText('Name') as HTMLInputElement).value).toBe('Malik')
    type('Launch command', 'envman -e claude:malik-sonnet --')
    fireEvent.click(within(editor()).getByRole('button', { name: 'Save' }))
    // Only the edited profile is sent: the server merges by id, so profiles this copy never saw survive.
    expect(lastProfiles(spy)).toEqual([{ id: 'm', name: 'Malik', command: 'envman -e claude:malik-sonnet --' }])
    expect(document.activeElement).toBe(within(row('Malik')).getByRole('button', { name: 'Edit' }))
    fireEvent.click(within(row('Malik')).getByRole('button', { name: 'Delete' }))
    const confirm = screen.getByRole('alertdialog', { name: 'Delete "Malik"?' })
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    fireEvent.click(within(row('Malik')).getByRole('button', { name: 'Delete' }))
    const puts: unknown[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit = {}) => {
      if (init.method === 'PUT') puts.push(JSON.parse(init.body as string))
      return new Response('{}', { status: 200 })
    }))
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }))
    // An explicit tombstone, awaited, with the pointers moved in the same write.
    await waitFor(() => expect(puts).toEqual([{ claudeLaunchProfiles: [{ id: 'm', deleted: true }], defaultClaudeProfileId: 'default', centralClaudeProfileId: '' }]))
  })

  it('a refused Delete (the provider runs it) is shown on the row and the profile stays', async () => {
    setup({ claudeLaunchProfiles: [MALIK] })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'profile_in_use', profileId: 'm', reason: 'provider' }), { status: 409 })))
    fireEvent.click(within(row('Malik')).getByRole('button', { name: 'Delete' }))
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }))
    const delBtn = within(screen.getByRole('alertdialog')).getByRole('button', { name: PROFILES_TEXT.removing })
    expect(delBtn.getAttribute('aria-busy')).toBe('true') // busy while the server answers
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull()) // closes on the answer
    expect((await within(row('Malik')).findByRole('alert')).textContent).toContain(PROFILES_TEXT.inUse('Malik', 'provider'))
    expect(row('Malik').querySelector('[data-action-result="failed"]')).toBeTruthy()
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
    expect(result.querySelector('[data-stage="wrapper"]')?.getAttribute('data-ok')).toBe('false')
    expect(result.textContent).toContain('✗')
    expect(result.textContent).toContain('envman not found on PATH')
    expect(result.textContent).toContain('Install it on the server')
    expect(JSON.parse((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ profileId: 'm' })
  })

  it('a failed Test request is reported, not swallowed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'unknown_profile' }), { status: 404 })))
    setup({ claudeLaunchProfiles: [MALIK] })
    fireEvent.click(within(row('Malik')).getByRole('button', { name: 'Test' }))
    expect(within(row('Malik')).getByRole('button', { name: PROFILES_TEXT.testing }).getAttribute('aria-busy')).toBe('true')
    await waitFor(() => expect(within(row('Malik')).getByRole('alert').textContent).toMatch(/unknown_profile/))
    // The failure also offers Retry (toast), which runs the test again.
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }))
    await waitFor(() => expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2))
  })

  it('"(Modified)" shows only when the stored list differs from the default', () => {
    setup()
    expect(screen.queryByText('(Modified)')).toBeNull()
    cleanup()
    setup({ claudeLaunchProfiles: [MALIK] })
    expect(screen.getAllByText('(Modified)')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Reset Setting: Claude launch profiles' })).toBeTruthy()
  })
  it('a stored document without the key loads as not modified; an empty stored profile is modified', () => {
    expect(isModified(mergeSettings({ fontSize: 13 }), 'claudeLaunchProfiles')).toBe(false)
    expect(isModified(mergeSettings({ claudeLaunchProfiles: [] }), 'claudeLaunchProfiles')).toBe(false)
    expect(isModified(mergeSettings({ claudeLaunchProfiles: [{ id: 'a', name: 'Profile 1', command: '' }] }), 'claudeLaunchProfiles')).toBe(true)
  })
  it('Reset Setting on the profile list asks first, naming what is lost; Cancel keeps them', () => {
    const spy = setup({ claudeLaunchProfiles: [MALIK, { id: 'w', name: 'Work', command: 'claude' }] })
    fireEvent.click(screen.getByRole('button', { name: 'Reset Setting: Claude launch profiles' }))
    const dialog = screen.getByRole('alertdialog', { name: 'Remove all 2 Claude launch profiles?' })
    expect(spy).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(spy).not.toHaveBeenCalled()
    expect(row('Work')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Reset Setting: Claude launch profiles' }))
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Reset' }))
    expect(spy).toHaveBeenLastCalledWith({ claudeLaunchProfiles: [{ id: 'm', deleted: true }, { id: 'w', deleted: true }] })
    expect(screen.queryByRole('region', { name: 'Work' })).toBeNull()
  })

  it('the profiles reset also moves the pointers off the deleted profiles (the server refuses a dangling one)', () => {
    const s = { ...DEFAULT_SETTINGS, claudeLaunchProfiles: [MALIK], defaultClaudeProfileId: 'm', centralClaudeProfileId: 'm' }
    expect(resetPatch('claudeLaunchProfiles', s)).toEqual({ claudeLaunchProfiles: [{ id: 'm', deleted: true }], defaultClaudeProfileId: 'default', centralClaudeProfileId: '' })
  })

  it('resetConfirmTitle: only non-empty lists and maps ask', () => {
    expect(resetConfirmTitle([1, 2], 'Claude launch profiles')).toBe('Remove all 2 Claude launch profiles?')
    expect(resetConfirmTitle({ a: 1 }, 'Keybindings')).toBe('Reset Keybindings? 1 entry will be removed.')
    expect(resetConfirmTitle([], 'X')).toBeNull()
    expect(resetConfirmTitle({}, 'X')).toBeNull()
    expect(resetConfirmTitle(false, 'X')).toBeNull()
    expect(resetConfirmTitle('abc', 'X')).toBeNull()
  })
})
