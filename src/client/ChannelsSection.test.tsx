/**
 * @vitest-environment jsdom
 */
// Section Channels: keadaan nonaktif/status/error, alur bind-abaikan-hapus, polling, dan jaminan
// bahwa tidak ada nilai token yang ikut dirender.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChannelsSection } from './ChannelsSection'
import { SettingsSearchProvider } from './SettingsFields'
import { CHANNELS_POLL_MS } from './useChannels'

vi.setConfig({ testTimeout: 30_000 })

interface Reply { status: number; body?: unknown }
interface Call { method: string; url: string; body?: string; token: string | null }

const NOW = 1_700_000_000_000
const dir = { okCount: 0, errorCount: 0 }
const STATUS = { mode: 'poll', enabled: true, botTokenSet: true, webhookSecretSet: false, pendingCount: 1, ingress: dir, egress: dir }
const PENDING = { chatId: '555', type: 'private', firstSeen: NOW - 60_000, lastSeen: NOW - 30_000, count: 3 }

let calls: Call[]
let routes: Record<string, Reply>

function reply(key: string): Reply {
  return routes[key] ?? { status: 200, body: { items: [] } }
}

beforeEach(() => {
  calls = []
  routes = {
    'GET /api/channels/telegram/status': { status: 200, body: STATUS },
    'GET /api/channels/telegram/pending': { status: 200, body: { items: [PENDING] } },
    'GET /api/channels/telegram/bindings': { status: 200, body: { items: [] } },
  }
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = (init.method ?? 'GET').toUpperCase()
    const headers = (init.headers ?? {}) as Record<string, string>
    calls.push({ method, url, body: init.body as string | undefined, token: headers['x-webterm-token'] ?? null })
    const r = reply(`${method} ${url.split('?')[0]}`)
    return new Response(JSON.stringify(r.body ?? { ok: true }), { status: r.status })
  }))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  sessionStorage.clear()
})

const count = (method: string, url: string): number => calls.filter((c) => c.method === method && c.url.startsWith(url)).length

describe('ChannelsSection', () => {
  it('shows the disabled state on 404 without any value', async () => {
    routes['GET /api/channels/telegram/status'] = { status: 404, body: { error: 'channel_disabled' } }
    render(<ChannelsSection />)
    expect(await screen.findByText('Channel Telegram nonaktif')).toBeTruthy()
    expect(screen.getByText(/WEBTERM_TELEGRAM=on/)).toBeTruthy()
    expect(count('GET', '/api/channels/telegram/pending')).toBe(0)
  })

  it('renders mode, token flag and ingress/egress incl. last error', async () => {
    routes['GET /api/channels/telegram/status'] = {
      status: 200,
      body: {
        ...STATUS,
        botToken: '123456:SECRET-TOKEN-VALUE',
        ingress: { okCount: 4, errorCount: 1, lastOk: Date.now() - 120_000, lastError: { at: Date.now() - 10_000, message: 'boom' } },
      },
    }
    render(<ChannelsSection />)
    expect(await screen.findByText('poll (long polling)')).toBeTruthy()
    expect(screen.getByText('Terpasang')).toBeTruthy()
    expect(screen.getByText(/4 OK \/ 1 error/)).toBeTruthy()
    expect(screen.getByText(/error terakhir \(10 dtk lalu\): boom/)).toBeTruthy()
    expect(screen.getByText(/terakhir OK: 2 mnt lalu/)).toBeTruthy()
    expect(document.body.textContent).not.toContain('SECRET-TOKEN-VALUE')
  })

  it('shows empty states for pending and bindings', async () => {
    routes['GET /api/channels/telegram/pending'] = { status: 200, body: { items: [] } }
    render(<ChannelsSection />)
    expect(await screen.findByText(/Tidak ada chat yang menunggu/)).toBeTruthy()
    expect(screen.getByText('Belum ada chat yang ter-bind.')).toBeTruthy()
  })

  it('binds a pending chat with the chosen role and refreshes', async () => {
    render(<ChannelsSection />)
    const row = await screen.findByRole('listitem', { name: '555' })
    const operator = within(within(row).getByRole('radiogroup', { name: 'Role 555' })).getByRole('radio', { name: 'operator' })
    fireEvent.click(operator)
    expect(operator.getAttribute('aria-checked')).toBe('true')
    fireEvent.change(within(row).getByLabelText('Project ID 555'), { target: { value: '  proj-1 ' } })
    routes['GET /api/channels/telegram/pending'] = { status: 200, body: { items: [] } }
    const before = count('GET', '/api/channels/telegram/status')
    fireEvent.click(within(row).getByRole('button', { name: 'Bind' }))

    await waitFor(() => expect(count('POST', '/api/channels/telegram/bindings')).toBe(1))
    const post = calls.find((c) => c.method === 'POST')!
    expect(JSON.parse(post.body!)).toEqual({ projectId: 'proj-1', chatId: '555', role: 'operator' })
    await waitFor(() => expect(count('GET', '/api/channels/telegram/status')).toBeGreaterThan(before))
    await waitFor(() => expect(screen.queryByRole('listitem', { name: '555' })).toBeNull())
  })

  it('refuses to bind with an empty project id and sends nothing', async () => {
    render(<ChannelsSection />)
    const row = await screen.findByRole('listitem', { name: '555' })
    fireEvent.click(within(row).getByRole('button', { name: 'Bind' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/Project ID wajib diisi/)
    expect(count('POST', '/api/channels/telegram/bindings')).toBe(0)
  })

  it('ignores a pending chat via DELETE', async () => {
    render(<ChannelsSection />)
    const row = await screen.findByRole('listitem', { name: '555' })
    fireEvent.click(within(row).getByRole('button', { name: 'Abaikan' }))
    await waitFor(() => expect(count('DELETE', '/api/channels/telegram/pending/555')).toBe(1))
  })

  it('removes a binding only after confirmation', async () => {
    routes['GET /api/channels/telegram/bindings'] = {
      status: 200,
      body: { items: [{ channel: 'telegram', chatId: '-77', projectId: 'p1', role: 'viewer' }] },
    }
    render(<ChannelsSection />)
    fireEvent.click(await screen.findByRole('button', { name: 'Hapus -77' }))
    expect(count('DELETE', '/api/channels/telegram/bindings')).toBe(0)
    fireEvent.click(await screen.findByRole('button', { name: 'Hapus' }))
    await waitFor(() => expect(count('DELETE', '/api/channels/telegram/bindings?chatId=-77')).toBe(1))
  })

  it('limits group chats to viewer/operator roles', async () => {
    routes['GET /api/channels/telegram/pending'] = { status: 200, body: { items: [{ ...PENDING, chatId: '-9' }] } }
    render(<ChannelsSection />)
    const group = await screen.findByRole('radiogroup', { name: 'Role -9' })
    expect(within(group).getAllByRole('radio').map((r) => r.textContent)).toEqual(['viewer', 'operator'])
  })

  it('shows a brief error without URL or token when the API fails', async () => {
    sessionStorage.setItem('webterm.token', 'tok-secret-123')
    routes['GET /api/channels/telegram/status'] = { status: 500, body: { error: 'x' } }
    render(<ChannelsSection />)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('Permintaan gagal. Coba lagi.')
    expect(document.body.textContent).not.toContain('tok-secret-123')
    expect(document.body.textContent).not.toContain('/api/')
    expect(calls[0]?.token).toBe('tok-secret-123')
  })

  it('shows a bind failure from the server', async () => {
    routes['POST /api/channels/telegram/bindings'] = { status: 400, body: { error: 'invalid_project_id' } }
    render(<ChannelsSection />)
    const row = await screen.findByRole('listitem', { name: '555' })
    fireEvent.change(within(row).getByLabelText('Project ID 555'), { target: { value: 'p' } })
    fireEvent.click(within(row).getByRole('button', { name: 'Bind' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Input ditolak server.')
  })

  it('polls on an interval and stops after unmount', async () => {
    vi.useFakeTimers()
    const { unmount } = render(<ChannelsSection />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    const first = count('GET', '/api/channels/telegram/status')
    expect(first).toBe(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(CHANNELS_POLL_MS) })
    expect(count('GET', '/api/channels/telegram/status')).toBe(2)
    unmount()
    await act(async () => { await vi.advanceTimersByTimeAsync(CHANNELS_POLL_MS * 3) })
    expect(count('GET', '/api/channels/telegram/status')).toBe(2)
  })

  it('renders nothing and does not fetch while a settings search is active', () => {
    const { container } = render(<SettingsSearchProvider query="font"><ChannelsSection /></SettingsSearchProvider>)
    expect(container.textContent).toBe('')
    expect(calls).toHaveLength(0)
  })
})
