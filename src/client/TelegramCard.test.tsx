/**
 * @vitest-environment jsdom
 */
// Kartu Telegram: tiap keadaan dari fixture, token write-only, peran tautan, polling hanya saat tab terlihat.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TelegramCard } from './TelegramCard'
import { PENDING_POLL_MS } from './useTelegramCard'

interface Reply { status: number; body?: unknown }
interface Call { method: string; url: string; body?: string }

const FAKE_TOKEN = '123456:FAKE-token-for-test-only' // test-only
const PROJECT = 'proj-1' // test-only
const caps = (status: string): unknown => ({ capabilities: [{ id: 'central', status: 'on' }, { id: 'telegram', status }] })
const priv = { chatId: '555', type: 'private', firstSeen: 1, lastSeen: 2, count: 1 }
const group = { chatId: '-100777', type: 'group', firstSeen: 1, lastSeen: 2, count: 1 }

let calls: Call[]
let routes: Record<string, Reply>

beforeEach(() => {
  calls = []
  routes = {
    'GET /api/capabilities': { status: 200, body: caps('off') },
    'GET /api/channels/telegram/pending': { status: 200, body: { items: [] } },
    'GET /api/channels/telegram/bindings': { status: 200, body: { items: [] } },
  }
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = (init.method ?? 'GET').toUpperCase()
    calls.push({ method, url, body: init.body as string | undefined })
    const r = routes[`${method} ${url.split('?')[0]}`] ?? { status: 200, body: { ok: true } }
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status })
  }))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
})

const connectedRoutes = (pending: unknown[] = [], bindings: unknown[] = []): void => {
  routes['GET /api/capabilities'] = { status: 200, body: caps('on') }
  routes['GET /api/channels/telegram/pending'] = { status: 200, body: { items: pending } }
  routes['GET /api/channels/telegram/bindings'] = { status: 200, body: { items: bindings } }
}
const submit = (): void => {
  fireEvent.change(screen.getByLabelText('Token bot'), { target: { value: FAKE_TOKEN } })
  fireEvent.click(screen.getByRole('button', { name: 'Hubungkan' }))
}

describe('TelegramCard', () => {
  it('belum terhubung: kolom password + Hubungkan', async () => {
    render(<TelegramCard projectId={PROJECT} />)
    const input = await screen.findByLabelText('Token bot')
    expect(input.getAttribute('type')).toBe('password')
    expect(screen.getByRole('button', { name: 'Hubungkan' })).toBeTruthy()
  })

  it('sukses: tersambung sebagai @nama, token tak ada di DOM, body hanya ke connect', async () => {
    routes['POST /api/capabilities/telegram/connect'] = { status: 200, body: { ok: true, bot: '@mybot' } }
    const { container } = render(<TelegramCard projectId={PROJECT} />)
    await screen.findByLabelText('Token bot')
    connectedRoutes()
    submit()
    expect(await screen.findByText('Tersambung sebagai @mybot')).toBeTruthy()
    expect(container.innerHTML).not.toContain(FAKE_TOKEN)
    expect(screen.getByRole('button', { name: 'Putuskan' })).toBeTruthy()
    expect(calls.find((c) => c.url.endsWith('/connect'))?.body).toContain(FAKE_TOKEN)
  })

  it('menghubungkan: tampil "Memeriksa token..." selagi menunggu', async () => {
    let release!: (r: Response) => void
    const base = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) =>
      url.endsWith('/connect') ? new Promise<Response>((r) => { release = r }) : base(url, init)))
    render(<TelegramCard projectId={PROJECT} />)
    await screen.findByLabelText('Token bot')
    submit()
    expect(await screen.findByText('Memeriksa token...')).toBeTruthy()
    release(new Response('{}', { status: 502 }))
    await waitFor(() => expect(screen.queryByText('Memeriksa token...')).toBeNull())
  })

  it.each([
    [422, 'token_rejected', 'Token ditolak Telegram. Salin ulang dari @BotFather.'],
    [502, 'unreachable', 'Tidak bisa menjangkau Telegram. Periksa koneksi internet lalu coba lagi.'],
    [400, 'invalid_token_shape', 'Bentuk token tidak dikenali. Salin lengkap dari @BotFather.'],
  ])('galat %i %s: pesan + input kosong + token tak di DOM', async (status, code, text) => {
    routes['POST /api/capabilities/telegram/connect'] = { status, body: { error: code } }
    const { container } = render(<TelegramCard projectId={PROJECT} />)
    await screen.findByLabelText('Token bot')
    submit()
    expect((await screen.findByRole('alert')).textContent).toBe(text)
    expect((screen.getByLabelText('Token bot') as HTMLInputElement).value).toBe('')
    expect(container.innerHTML).not.toContain(FAKE_TOKEN)
  })

  it('chat menunggu: privat -> owner, grup -> viewer, memakai projectId prop', async () => {
    connectedRoutes([priv, group])
    render(<TelegramCard projectId={PROJECT} />)
    expect(await screen.findByText('Chat 555 mengirim pesan ke bot. Tautkan chat ini?')).toBeTruthy()
    const [linkPriv, linkGroup] = screen.getAllByRole('button', { name: 'Tautkan' })
    fireEvent.click(linkPriv!)
    fireEvent.click(linkGroup!)
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST' && c.url.endsWith('/bindings'))).toHaveLength(2))
    const bodies = calls.filter((c) => c.url.endsWith('/bindings') && c.method === 'POST').map((c) => JSON.parse(c.body!))
    expect(bodies).toContainEqual({ projectId: PROJECT, chatId: '555', role: 'owner' })
    expect(bodies).toContainEqual({ projectId: PROJECT, chatId: '-100777', role: 'viewer' })
  })

  it('Abaikan memanggil DELETE pending', async () => {
    connectedRoutes([priv])
    render(<TelegramCard projectId={PROJECT} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Abaikan' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/pending/555'))).toBe(true))
  })

  it('chat tertaut: daftar + Putuskan memanggil unbind; teks tanpa kata terlarang', async () => {
    connectedRoutes([], [{ chatId: '555', projectId: PROJECT, role: 'owner' }])
    const { container } = render(<TelegramCard projectId={PROJECT} />)
    expect(await screen.findByText('Chat 555')).toBeTruthy()
    expect(container.textContent).not.toMatch(/webhook|polling|secret|mode/i)
    const buttons = screen.getAllByRole('button', { name: 'Putuskan' })
    fireEvent.click(buttons[buttons.length - 1]!)
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.url.includes('/bindings?chatId=555'))).toBe(true))
  })

  it('Putuskan (bot) mematikan kemampuan telegram lalu kembali ke belum terhubung walau token tersimpan', async () => {
    connectedRoutes([priv], [{ chatId: '555', projectId: PROJECT, role: 'owner' }])
    // botTokenSet tetap true setelah Putuskan: bukan penentu tersambung.
    routes['GET /api/channels/telegram/status'] = { status: 200, body: { botTokenSet: true } }
    render(<TelegramCard projectId={PROJECT} />)
    const btns = await screen.findAllByRole('button', { name: 'Putuskan' })
    routes['GET /api/capabilities'] = { status: 200, body: caps('off') }
    fireEvent.click(btns[0]!)
    expect(await screen.findByLabelText('Token bot')).toBeTruthy()
    const c = calls.find((x) => x.method === 'POST' && x.url === '/api/capabilities/telegram')
    expect(JSON.parse(c?.body ?? '{}')).toEqual({ enabled: false })
    expect(screen.getByRole('button', { name: 'Hubungkan' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Tautkan' })).toBeNull()
    expect(screen.queryByText('Chat 555')).toBeNull()
  })

  it("status 'needs-step' = belum terhubung", async () => {
    routes['GET /api/capabilities'] = { status: 200, body: caps('needs-step') }
    routes['GET /api/channels/telegram/status'] = { status: 200, body: { botTokenSet: true } }
    render(<TelegramCard projectId={PROJECT} />)
    expect(await screen.findByLabelText('Token bot')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Putuskan' })).toBeNull()
  })

  it('polling berhenti saat tab hidden dan lanjut saat visible', async () => {
    vi.useFakeTimers()
    connectedRoutes()
    render(<TelegramCard projectId={PROJECT} />)
    const pendingCalls = (): number => calls.filter((c) => c.url.endsWith('/pending')).length
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    const initial = pendingCalls()
    await act(async () => { await vi.advanceTimersByTimeAsync(PENDING_POLL_MS) })
    expect(pendingCalls()).toBe(initial + 1)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await act(async () => { await vi.advanceTimersByTimeAsync(PENDING_POLL_MS * 3) })
    expect(pendingCalls()).toBe(initial + 1)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await act(async () => { await vi.advanceTimersByTimeAsync(PENDING_POLL_MS) })
    expect(pendingCalls()).toBe(initial + 2)
  })
})
