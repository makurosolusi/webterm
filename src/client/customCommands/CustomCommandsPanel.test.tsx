/** @vitest-environment jsdom */
// The shared custom-commands panel against a fake server: every state (loading, error + Retry, empty,
// ready), Rescan, Add folder (ok / server 400), Remove, Add permanently, and the compatibility badge.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { COMMANDS_TEXT as T } from './commands.labels'
import { fakeCommands, TOOL } from './commands.fakeServer'
import { shortenHome } from './commands.path'
import { CustomCommandsPanel } from './CustomCommandsPanel'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const click = (name: string | RegExp): void => { fireEvent.click(screen.getByRole('button', { name })) }
const ready = async (): Promise<void> => { await screen.findByText(T.found.title) }
const type = (v: string): void => { fireEvent.change(screen.getByRole('combobox', { name: T.add.label }), { target: { value: v } }) }

describe('CustomCommandsPanel', () => {
  it('loading, then the found tools with source, status and a home-shortened path', async () => {
    fakeCommands({ detected: [TOOL({ path: '/Users/me/.local/bin/tool-a' }), TOOL({ name: 'known', path: null, found: false, source: 'candidate' })] })
    render(<CustomCommandsPanel />)
    expect(screen.getByText(T.loading)).toBeTruthy()
    await ready()
    const row = document.querySelector('[data-command="tool-a"]') as HTMLElement
    expect(row.textContent).toContain(`${T.found.ok} · ${T.found.source.extra}`)
    expect(row.textContent).toContain('~/.local/bin/tool-a')
    expect((document.querySelector('[data-command="known"]') as HTMLElement).textContent).toContain(`${T.found.missing} · ${T.found.source.candidate}`)
    expect(screen.getByText(T.hint)).toBeTruthy()
  })

  it('empty states for no tools and no folders', async () => {
    fakeCommands({ detected: [] })
    render(<CustomCommandsPanel />)
    await ready()
    expect(screen.getByText(T.found.empty)).toBeTruthy()
    expect(screen.getByText(T.folders.empty)).toBeTruthy()
    expect(document.querySelector('[data-commands-session]')).toBeNull()
  })

  it('a failed load says why and Retry loads it again', async () => {
    const s = fakeCommands({ loadFail: 1 })
    render(<CustomCommandsPanel />)
    expect((await screen.findByRole('alert')).textContent).toContain(T.loadFailed)
    click(T.retry)
    await ready()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(s.calls.filter((c) => c.url.endsWith('/detect'))).toHaveLength(2)
  })

  it('shows the server compatibility message on a wrong-platform tool', async () => {
    const msg = 'tool-b is a macOS arm64 binary; this machine is linux/amd64.'
    fakeCommands({ detected: [TOOL({ name: 'tool-b', compat: 'wrong_platform', compatMessage: msg })] })
    render(<CustomCommandsPanel />)
    await ready()
    expect(screen.getByText(T.compat.wrong_platform)).toBeTruthy()
    expect(screen.getByText(msg)).toBeTruthy()
  })

  it('Rescan posts, reloads and announces the count', async () => {
    const s = fakeCommands({ rescanAdded: 2 })
    render(<CustomCommandsPanel />)
    await ready()
    click(T.rescan.button)
    expect(await screen.findByText(T.rescan.result(2))).toBeTruthy()
    expect(screen.getByRole('status').textContent).toContain('2 directories added')
    expect(s.calls.some((c) => c.url.endsWith('/rescan') && c.method === 'POST')).toBe(true)
    expect(s.calls.filter((c) => c.url.endsWith('/detect'))).toHaveLength(2)
  })

  it('Rescan failure is an alert with the server message', async () => {
    fakeCommands({ rescanFail: true })
    render(<CustomCommandsPanel />)
    await ready()
    click(T.rescan.button)
    expect((await screen.findByRole('alert')).textContent).toContain(`${T.rescan.failed}: Scan failed.`)
  })

  it('Add folder is locked until something is typed, then posts the folder and lists it', async () => {
    const s = fakeCommands()
    render(<CustomCommandsPanel />)
    await ready()
    expect(screen.getByText(T.add.needDir)).toBeTruthy()
    expect((screen.getByRole('button', { name: T.add.button }) as HTMLButtonElement).disabled).toBe(true)
    type('/home/u/tools')
    click(T.add.button)
    expect(await screen.findByText(T.add.done('/home/u/tools'))).toBeTruthy()
    expect(s.calls.find((c) => c.url.endsWith('/paths') && c.method === 'POST')?.body).toEqual({ dir: '/home/u/tools' })
    await waitFor(() => expect(document.querySelector('[data-folder="/home/u/tools"]')).toBeTruthy())
    expect((screen.getByRole('combobox', { name: T.add.label }) as HTMLInputElement).value).toBe('')
  })

  it('the presets are the common folders', async () => {
    fakeCommands()
    render(<CustomCommandsPanel />)
    await ready()
    fireEvent.click(screen.getByRole('button', { name: 'Show suggestions' }))
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['/home/u/.local/bin', '/usr/local/bin'])
  })

  it('a server 400 shows its message and keeps what was typed', async () => {
    fakeCommands({ addError: { status: 400, error: 'unsafe_path_dir', message: 'That folder is writable by other users.' } })
    render(<CustomCommandsPanel />)
    await ready()
    type('/tmp/open')
    click(T.add.button)
    expect((await screen.findByRole('alert')).textContent).toContain(`${T.add.failed}: That folder is writable by other users.`)
    expect((screen.getByRole('combobox', { name: T.add.label }) as HTMLInputElement).value).toBe('/tmp/open')
  })

  it('a relative folder is refused in the box before any request', async () => {
    const s = fakeCommands()
    render(<CustomCommandsPanel />)
    await ready()
    const box = screen.getByRole('combobox', { name: T.add.label })
    fireEvent.change(box, { target: { value: 'tools' } })
    fireEvent.blur(box)
    expect((await screen.findByRole('alert')).textContent).toBe(T.add.notAbsolute)
    expect(s.calls.some((c) => c.method === 'POST')).toBe(false)
  })

  it('lists extra folders with their problems; Remove deletes one, and a failed Remove says why', async () => {
    const s = fakeCommands()
    s.paths.extra = [{ dir: '/opt/a', exists: true, safe: true }, { dir: '/opt/gone', exists: false, safe: true }, { dir: '/tmp/x', exists: true, safe: false }]
    render(<CustomCommandsPanel />)
    await ready()
    expect(screen.getByText(T.folders.missing)).toBeTruthy()
    expect(screen.getByText(T.folders.unsafe)).toBeTruthy()
    s.removeFail = true
    click(T.folders.removeLabel('/opt/a'))
    expect((await screen.findByRole('alert')).textContent).toContain(`${T.folders.removeFailed}: Could not write the folder list.`)
    s.removeFail = false
    click(T.folders.removeLabel('/opt/a'))
    await waitFor(() => expect(document.querySelector('[data-folder="/opt/a"]')).toBeNull())
    expect(s.calls.filter((c) => c.url.endsWith('/paths/remove')).map((c) => c.body)).toEqual([{ dir: '/opt/a' }, { dir: '/opt/a' }])
  })

  it('this-session folders offer Add permanently, which posts the folder and moves it to the list', async () => {
    const s = fakeCommands()
    s.paths.session = [{ name: 'tool-a', dir: '/home/u/.x/bin' }, { name: 'tool-b', dir: '/home/u/.x/bin' }]
    render(<CustomCommandsPanel />)
    await ready()
    const group = document.querySelector('[data-commands-session]') as HTMLElement
    expect(within(group).getByText(/tool-a, tool-b/)).toBeTruthy()
    click(T.session.buttonLabel('/home/u/.x/bin'))
    await waitFor(() => expect(document.querySelector('[data-folder="/home/u/.x/bin"]')).toBeTruthy())
    expect(document.querySelector('[data-commands-session]')).toBeNull()
    expect(s.calls.find((c) => c.url.endsWith('/paths') && c.method === 'POST')?.body).toEqual({ dir: '/home/u/.x/bin' })
  })

  it('two panels keep their own state (nothing global)', async () => {
    fakeCommands()
    render(<><CustomCommandsPanel /><CustomCommandsPanel /></>)
    await waitFor(() => expect(screen.getAllByText(T.found.title)).toHaveLength(2))
    expect(shortenHome('/home/u/x')).toBe('~/x')
    expect(shortenHome('/opt/x')).toBe('/opt/x')
  })
})
