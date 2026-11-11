/** @vitest-environment jsdom */
// "Custom command" mode of the Claude provider card, against a fetch mock that follows the server contract:
// the command is saved as a launch profile (/api/settings) and the provider points at it by profileId.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ClaudeProviderCard, PROVIDER_TEXT } from './ClaudeProviderCard'
import { COMMAND_TEXT, commandName } from './ClaudeProviderCommand'
import { CONNECTION_TEXT } from './claudeLauncher/ConnectionTest'

type Call = { url: string; method: string; body?: any }
let calls: Call[] = []
const CMD = 'envman -e claude:malik-opus -- claude'

interface World {
  provider?: Record<string, unknown>
  profiles?: { id: string; name: string; command: string }[]
  wrappers?: { name: string; installed: boolean }[]
  test?: Record<string, unknown>
  testDelay?: Promise<void>
  restartNeeded?: number
}

function serve(w: World = {}): void {
  let profiles = w.profiles ?? []
  let provider: Record<string, unknown> = w.provider ?? { mode: 'login', secretSet: false, ready: true }
  const json = (o: unknown): Response => new Response(JSON.stringify(o), { status: 200 })
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET'
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined
    calls.push({ url, method, body })
    if (url.startsWith('/api/settings')) {
      if (method === 'PUT') profiles = body.claudeLaunchProfiles
      return json({ claudeLaunchProfiles: profiles })
    }
    if (url === '/api/claude-provider/detect') return json({ wrappers: w.wrappers ?? [] })
    if (url === '/api/claude-provider/test') {
      await w.testDelay
      const t = (w.test ?? { ok: true, message: 'Claude answered through your command.' }) as { ok: boolean; message: string }
      return new Response(`${JSON.stringify({ result: t.ok ? 'ok' : 'failed', summary: t.message, ms: 1, via: 'envman' })}\n`, { status: 200 })
    }
    if (method === 'PUT') {
      const profile = profiles.find((x) => x.id === body.profileId)
      provider = body.mode === 'command'
        ? { mode: 'command', profileId: body.profileId, profile, secretSet: false, ready: !!profile }
        : { mode: body.mode, secretSet: false, ready: true }
    }
    return json({ provider, lastTest: null, restartNeeded: w.restartNeeded ?? 0 })
  }))
}
const PUTS = (): Call[] => calls.filter((c) => c.method === 'PUT')
const open = async (): Promise<void> => { fireEvent.click(await screen.findByRole('button', { name: PROVIDER_TEXT.modes.command })) }

beforeEach(() => { calls = [] })
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('Claude provider: Custom command', () => {
  it('always shows four mode buttons, with aria-pressed on the active one', async () => {
    serve()
    render(<ClaudeProviderCard />)
    await screen.findByRole('button', { name: PROVIDER_TEXT.modes.command })
    for (const label of Object.values(PROVIDER_TEXT.modes)) expect(screen.getByRole('button', { name: label })).toBeTruthy()
    expect(Object.keys(PROVIDER_TEXT.modes)).toHaveLength(4)
    expect(screen.getByRole('button', { name: PROVIDER_TEXT.modes.login }).getAttribute('aria-pressed')).toBe('true')
    await open()
    expect(screen.getByRole('button', { name: PROVIDER_TEXT.modes.command }).getAttribute('aria-pressed')).toBe('true')
  })

  it('choosing it shows the command form, no key field and the credentials note', async () => {
    serve()
    render(<ClaudeProviderCard />)
    await open()
    const input = await screen.findByLabelText(COMMAND_TEXT.command) as HTMLInputElement
    expect(input.placeholder).toBe(COMMAND_TEXT.placeholder)
    expect(screen.getByText(COMMAND_TEXT.note)).toBeTruthy()
    expect(screen.queryByLabelText(PROVIDER_TEXT.key)).toBeNull()
    expect(screen.queryByLabelText(PROVIDER_TEXT.baseUrl)).toBeNull()
  })

  it('Save creates the profile through /api/settings first, then PUTs the provider with its profileId', async () => {
    serve()
    render(<ClaudeProviderCard />)
    await open()
    fireEvent.change(await screen.findByLabelText(COMMAND_TEXT.command), { target: { value: CMD } })
    expect((screen.getByLabelText(COMMAND_TEXT.name) as HTMLInputElement).value).toBe('envman: claude:malik-opus')
    fireEvent.click(screen.getByRole('button', { name: COMMAND_TEXT.save }))
    expect(await screen.findByText(new RegExp(PROVIDER_TEXT.saved))).toBeTruthy()
    const puts = PUTS()
    expect(puts.map((c) => c.url.split('?')[0])).toEqual(['/api/settings', '/api/claude-provider'])
    const [saved] = puts[0]!.body.claudeLaunchProfiles
    expect(saved).toMatchObject({ name: 'envman: claude:malik-opus', command: CMD })
    expect(puts[1]!.body).toEqual({ mode: 'command', profileId: saved.id })
  })

  it('reports new profiles to the host so the Settings panel copy stays in step', async () => {
    serve()
    const onProfiles = vi.fn()
    render(<ClaudeProviderCard onProfiles={onProfiles} />)
    await open()
    fireEvent.change(await screen.findByLabelText(COMMAND_TEXT.command), { target: { value: CMD } })
    fireEvent.click(screen.getByRole('button', { name: COMMAND_TEXT.save }))
    await waitFor(() => expect(onProfiles).toHaveBeenCalledTimes(1))
    expect(onProfiles.mock.calls[0]![0]).toMatchObject([{ command: CMD }])
  })

  it('a custom name is kept; a saved profile is remembered and refills the command when picked again', async () => {
    serve({ profiles: [{ id: 'p1', name: 'Work', command: 'op run -- claude' }, { id: 'p2', name: 'Home', command: CMD }] })
    render(<ClaudeProviderCard />)
    await open()
    fireEvent.click(await screen.findByRole('button', { name: 'Work' }))
    expect((screen.getByLabelText(COMMAND_TEXT.command) as HTMLInputElement).value).toBe('op run -- claude')
    expect((screen.getByLabelText(COMMAND_TEXT.name) as HTMLInputElement).value).toBe('Work')
    expect(screen.getByRole('button', { name: 'Work' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Home' }))
    expect((screen.getByLabelText(COMMAND_TEXT.command) as HTMLInputElement).value).toBe(CMD)
    fireEvent.click(screen.getByRole('button', { name: COMMAND_TEXT.save }))
    await screen.findByText(new RegExp(PROVIDER_TEXT.saved))
    // Existing profile, unchanged: no settings write, only the provider PUT.
    expect(PUTS().map((c) => c.url)).toEqual(['/api/claude-provider'])
    expect(PUTS()[0]!.body).toEqual({ mode: 'command', profileId: 'p2' })
  })

  it('editing a picked profile updates it in place (same id, no duplicate)', async () => {
    serve({ profiles: [{ id: 'p1', name: 'Work', command: 'op run -- claude' }] })
    render(<ClaudeProviderCard />)
    await open()
    fireEvent.click(await screen.findByRole('button', { name: 'Work' }))
    fireEvent.change(screen.getByLabelText(COMMAND_TEXT.command), { target: { value: CMD } })
    fireEvent.click(screen.getByRole('button', { name: COMMAND_TEXT.save }))
    await screen.findByText(new RegExp(PROVIDER_TEXT.saved))
    expect(PUTS()[0]!.body.claudeLaunchProfiles).toEqual([{ id: 'p1', name: 'Work', command: CMD }])
    expect(PUTS()[1]!.body.profileId).toBe('p1')
  })

  it('a provider already in command mode opens with its command filled in', async () => {
    const profile = { id: 'p1', name: 'Home', command: CMD }
    serve({ profiles: [profile], provider: { mode: 'command', profileId: 'p1', profile, secretSet: false, ready: true } })
    render(<ClaudeProviderCard />)
    expect((await screen.findByLabelText(COMMAND_TEXT.command) as HTMLInputElement).value).toBe(CMD)
    expect((screen.getByLabelText(COMMAND_TEXT.name) as HTMLInputElement).value).toBe('Home')
  })

  it('shows a wrapper chip parsed from the command, none for a bare claude', async () => {
    serve()
    render(<ClaudeProviderCard />)
    await open()
    const input = await screen.findByLabelText(COMMAND_TEXT.command)
    expect(screen.queryByText(COMMAND_TEXT.wrapper('envman'))).toBeNull()
    fireEvent.change(input, { target: { value: CMD } })
    expect(screen.getByText(COMMAND_TEXT.wrapper('envman'))).toBeTruthy()
    fireEvent.change(input, { target: { value: 'claude --model opus' } })
    expect(screen.queryByText(/^wrapper:/)).toBeNull()
  })

  it('offers the envman template only when envman is installed, and selects its placeholder', async () => {
    serve({ wrappers: [{ name: 'envman', installed: true }, { name: 'direnv', installed: false }] })
    render(<ClaudeProviderCard />)
    await open()
    fireEvent.click(await screen.findByRole('button', { name: COMMAND_TEXT.template }))
    const input = screen.getByLabelText(COMMAND_TEXT.command) as HTMLInputElement
    expect(input.value).toBe('envman -e project:env -- claude')
    expect(input.value.slice(input.selectionStart ?? 0, input.selectionEnd ?? 0)).toBe('project:env')
  })

  it('hides the template when envman is not installed', async () => {
    serve({ wrappers: [{ name: 'envman', installed: false }] })
    render(<ClaudeProviderCard />)
    await open()
    await screen.findByLabelText(COMMAND_TEXT.command)
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/detect'))).toBe(true))
    expect(screen.queryByRole('button', { name: COMMAND_TEXT.template })).toBeNull()
  })

  it('warns, without blocking, when the server says the command looks like a secret', async () => {
    const profile = { id: 'p1', name: 'Leaky', command: 'env ANTHROPIC_API_KEY=abc claude' }
    serve({ profiles: [profile], provider: { mode: 'command', profileId: 'p1', profile, commandWarning: 'looks_like_secret', secretSet: false, ready: true } })
    render(<ClaudeProviderCard />)
    expect(await screen.findByText(COMMAND_TEXT.secret)).toBeTruthy()
    // The warning never blocks: an edit enables Save (unchanged, it reads "Saved").
    await screen.findByRole('button', { name: COMMAND_TEXT.clean })
    fireEvent.change(screen.getByLabelText(COMMAND_TEXT.command), { target: { value: CMD } })
    expect((screen.getByRole('button', { name: COMMAND_TEXT.save }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('tells the user when the selected profile was removed, with nothing selected', async () => {
    serve({ profiles: [{ id: 'p9', name: 'Other', command: CMD }], provider: { mode: 'command', profileId: 'gone', profileMissing: true, secretSet: false, ready: false } })
    render(<ClaudeProviderCard />)
    expect(await screen.findByText(COMMAND_TEXT.missing)).toBeTruthy()
    expect((screen.getByLabelText(COMMAND_TEXT.command) as HTMLInputElement).value).toBe('')
    expect((await screen.findByRole('button', { name: 'Other' })).getAttribute('aria-pressed')).toBe('false')
  })

  it('Test connection saves first, shows Testing… while it runs, then the server summary', async () => {
    let release = (): void => undefined
    serve({ testDelay: new Promise<void>((r) => { release = r }) })
    render(<ClaudeProviderCard />)
    await open()
    fireEvent.change(await screen.findByLabelText(COMMAND_TEXT.command), { target: { value: CMD } })
    fireEvent.click(screen.getByRole('button', { name: CONNECTION_TEXT.button.idle }))
    const busy = await screen.findByRole('button', { name: CONNECTION_TEXT.button.running }) as HTMLButtonElement
    expect(busy.disabled).toBe(true)
    expect(screen.getAllByRole('status').some((s) => s.textContent?.startsWith('Testing…'))).toBe(true)
    release()
    expect(await screen.findByText('Claude answered through your command.')).toBeTruthy()
    expect(calls.filter((c) => c.method !== 'GET').map((c) => c.url.split('?')[0])).toEqual(['/api/settings', '/api/claude-provider', '/api/claude-provider/test'])
    expect(screen.getAllByRole('status').some((s) => s.querySelector('.codicon-pass'))).toBe(true)
  })

  it('shows a failing test as the server summary in an alert with an error icon', async () => {
    serve({ test: { ok: false, message: 'The command was not found on the server.' } })
    render(<ClaudeProviderCard />)
    await open()
    fireEvent.change(await screen.findByLabelText(COMMAND_TEXT.command), { target: { value: 'nope -- claude' } })
    fireEvent.click(screen.getByRole('button', { name: CONNECTION_TEXT.button.idle }))
    const msg = await screen.findByText('The command was not found on the server.')
    expect(msg.closest('p')?.className).toContain('text-destructive')
    expect(msg.closest('p')?.getAttribute('role')).toBe('alert')
    expect(msg.closest('p')?.querySelector('.codicon-error')).toBeTruthy()
  })

  it('shows the restart hint after saving, like the other modes', async () => {
    serve({ restartNeeded: 2 })
    render(<ClaudeProviderCard />)
    await open()
    fireEvent.change(await screen.findByLabelText(COMMAND_TEXT.command), { target: { value: CMD } })
    fireEvent.click(screen.getByRole('button', { name: COMMAND_TEXT.save }))
    expect(await screen.findByText(new RegExp(PROVIDER_TEXT.restart(2).slice(0, 40)))).toBeTruthy()
  })

  it('the other modes are unchanged: login has no form, custom endpoint saves the old body', async () => {
    serve()
    render(<ClaudeProviderCard />)
    await screen.findByText(PROVIDER_TEXT.modeHelp.login)
    expect(screen.queryByLabelText(COMMAND_TEXT.command)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: PROVIDER_TEXT.modes.custom }))
    fireEvent.change(screen.getByLabelText(PROVIDER_TEXT.baseUrl), { target: { value: 'https://gw.example.test' } })
    fireEvent.click(screen.getByRole('button', { name: PROVIDER_TEXT.save }))
    await screen.findByText(new RegExp(PROVIDER_TEXT.saved))
    expect(PUTS()).toHaveLength(1)
    expect(PUTS()[0]!.body).toMatchObject({ mode: 'custom', baseUrl: 'https://gw.example.test', credential: 'authToken' })
    expect(PUTS()[0]!.body).not.toHaveProperty('profileId')
  })

  it('the saved command reads "Saved" (disabled) until edited; Save then shows a fresh "✓ Saved at" line', async () => {
    const profile = { id: 'p1', name: 'envman: claude:malik-opus', command: CMD }
    serve({ profiles: [profile], provider: { mode: 'command', profileId: 'p1', profile, secretSet: false, ready: true } })
    render(<ClaudeProviderCard />)
    const clean = await screen.findByRole('button', { name: COMMAND_TEXT.clean }) as HTMLButtonElement
    expect(clean.disabled).toBe(true)
    expect(clean.title).toBe(COMMAND_TEXT.noChanges)
    fireEvent.change(screen.getByLabelText(COMMAND_TEXT.command), { target: { value: `${CMD} --verbose` } })
    fireEvent.click(screen.getByRole('button', { name: COMMAND_TEXT.save }))
    expect((await screen.findByText(new RegExp(`^${PROVIDER_TEXT.saved} at `))).getAttribute('role')).toBe('status')
    expect(await screen.findByText(PROVIDER_TEXT.savedToast)).toBeTruthy()
    expect((screen.getByRole('button', { name: COMMAND_TEXT.clean }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('names a command after its wrapper and -e target', () => {
    expect(commandName(CMD)).toBe('envman: claude:malik-opus')
    expect(commandName('/usr/local/bin/envman -e a:b --')).toBe('envman: a:b')
    expect(commandName('claude')).toBe(COMMAND_TEXT.fallbackName)
    expect(commandName('  ')).toBe('')
  })
})
