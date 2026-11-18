/** @vitest-environment jsdom */
// Tombol pemulihan overlay: "Izinkan host:port" menulis allowlist lalu membuka ulang; Chromium hilang -> tawaran kemampuan.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import './vscode/test-setup'
import type { BrowserState } from '../shared/browser.contract'
import BrowserNoticeAction from './browser.noticeAction'
import { NOTICE_ACTION_TEXT as T } from './browser.uxText'

vi.mock('./CapabilityOffer', () => ({
  CapabilityOffer: ({ id }: { id: string }) => <div data-testid="offer">{id}</div>,
}))

const blocked = (b: BrowserState['blocked']): BrowserState =>
  ({ id: 'n1', url: 'about:blank', title: '', loading: false, canBack: false, canForward: false, lease: 'human', live: 'live', blocked: b })

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('BrowserNoticeAction', () => {
  it('Izinkan localhost:3000 -> PUT allowlist (dengan alias) lalu navigasi ulang ke target', async () => {
    const calls: Array<{ url: string; method?: string; body?: unknown }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, method: init.method, body: init.body })
      return new Response(JSON.stringify({ entries: [] }), { status: 200 })
    }))
    const nav = vi.fn()
    render(<BrowserNoticeAction state={blocked('private_host')} target="http://localhost:3000/" nav={nav} />)
    fireEvent.click(screen.getByRole('button', { name: T.allow('localhost:3000') }))
    await waitFor(() => expect(nav).toHaveBeenCalledWith('go', 'http://localhost:3000/'))
    expect(JSON.parse(String(calls[1]!.body)).set.WEBTERM_BROWSER_ALLOW_HOSTS).toBe('localhost:3000,127.0.0.1:3000')
  })

  it('gagal simpan (mis. 403) -> pesan galat, tanpa navigasi', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 403 })))
    const nav = vi.fn()
    render(<BrowserNoticeAction state={blocked('private_host')} target="http://10.0.0.5:8080/" nav={nav} />)
    fireEvent.click(screen.getByRole('button', { name: T.allow('10.0.0.5:8080') }))
    expect((await screen.findByRole('alert')).textContent).toBe(T.allowFailed)
    expect(nav).not.toHaveBeenCalled()
  })

  it('Chromium hilang -> tombol membuka tawaran kemampuan Browser', () => {
    render(<BrowserNoticeAction state={blocked('no_binary')} nav={vi.fn()} />)
    expect(screen.queryByTestId('offer')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: T.offer }))
    expect(screen.getByTestId('offer').textContent).toBe('browser')
  })

  it('failed navigation -> plate with title, host, hint; Try again reloads', () => {
    const nav = vi.fn()
    render(<BrowserNoticeAction state={{ ...blocked(undefined), url: 'https://nope.invalid/', netError: 'net::ERR_NAME_NOT_RESOLVED' }} nav={nav} />)
    const plate = screen.getByRole('alert')
    expect(plate.textContent).toContain("This site can't be reached")
    expect(plate.textContent).toContain('nope.invalid')
    expect(plate.textContent).toContain('Check the address for typos.')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(nav).toHaveBeenCalledWith('reload')
  })

  it('not retryable -> plate without Try again; cleared netError -> nothing', () => {
    const st = { ...blocked(undefined), url: 'https://ads.example/', netError: 'net::ERR_BLOCKED_BY_CLIENT' }
    const { container, rerender } = render(<BrowserNoticeAction state={st} nav={vi.fn()} />)
    expect(screen.getByRole('alert')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
    rerender(<BrowserNoticeAction state={{ ...st, netError: undefined }} nav={vi.fn()} />)
    expect(container.innerHTML).toBe('')
  })

  it('failed launch (no state yet) -> plate over the start page; Try again reloads, shows progress until the next answer', () => {
    const nav = vi.fn()
    const { rerender } = render(<BrowserNoticeAction error={{ code: 'launch_failed' }} nav={nav} />)
    expect(screen.getByRole('alert').textContent).toContain('Chromium could not start')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(nav).toHaveBeenCalledWith('reload')
    expect((screen.getByRole('button', { name: 'Trying again…' }) as HTMLButtonElement).disabled).toBe(true)
    rerender(<BrowserNoticeAction error={{ code: 'launch_failed' }} nav={nav} />) // a new error object = the retry failed again
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
  })

  it('failed launch names the specific cause the server found', () => {
    render(<BrowserNoticeAction error={{ code: 'launch_failed', reason: 'profile_locked' }} nav={vi.fn()} />)
    const plate = screen.getByRole('alert')
    expect(plate.textContent).toContain('holding this browser profile')
    expect(plate.textContent).toContain('profile_locked')
  })

  it('halaman normal -> tidak merender apa pun', () => {
    const { container } = render(<BrowserNoticeAction state={{ ...blocked(undefined) }} nav={vi.fn()} />)
    expect(container.innerHTML).toBe('')
  })
})
