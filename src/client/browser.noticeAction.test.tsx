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

  it('halaman normal -> tidak merender apa pun', () => {
    const { container } = render(<BrowserNoticeAction state={{ ...blocked(undefined) }} nav={vi.fn()} />)
    expect(container.innerHTML).toBe('')
  })
})
