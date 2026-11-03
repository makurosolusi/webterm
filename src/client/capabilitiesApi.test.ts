// Klien /api/capabilities: rute, body, header token, dan galat berkode tanpa body mentah.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CapabilitiesApiError, fetchCapabilities, setCapability, setCapabilitySub } from './capabilitiesApi'

afterEach(() => { vi.unstubAllGlobals() })

const OK = { capabilities: [{ id: 'central', status: 'on' }], advanced: {} }
const reply = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('capabilitiesApi', () => {
  it('GETs /api/capabilities', async () => {
    const f = vi.fn().mockResolvedValue(reply(200, OK))
    vi.stubGlobal('fetch', f)
    await expect(fetchCapabilities()).resolves.toEqual(OK)
    expect(f.mock.calls[0][0]).toBe('/api/capabilities')
    expect(f.mock.calls[0][1].method).toBe('GET')
  })

  it('POSTs {enabled} to the capability route', async () => {
    const f = vi.fn().mockResolvedValue(reply(200, OK))
    vi.stubGlobal('fetch', f)
    await setCapability('workers', true)
    expect(f.mock.calls[0][0]).toBe('/api/capabilities/workers')
    expect(f.mock.calls[0][1].method).toBe('POST')
    expect(JSON.parse(f.mock.calls[0][1].body)).toEqual({ enabled: true })
  })

  it('POSTs {key,on} to the sub route', async () => {
    const f = vi.fn().mockResolvedValue(reply(200, OK))
    vi.stubGlobal('fetch', f)
    await setCapabilitySub('workers', 'K', false)
    expect(f.mock.calls[0][0]).toBe('/api/capabilities/workers/sub')
    expect(JSON.parse(f.mock.calls[0][1].body)).toEqual({ key: 'K', on: false })
  })

  it('throws a coded error that never carries the raw body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(403, { error: 'forbidden', leak: 'SECRET-BODY' })))
    const err = await setCapability('files', true).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CapabilitiesApiError)
    expect(err).toMatchObject({ status: 403, code: 'forbidden' })
    expect(String((err as Error).message)).not.toContain('SECRET-BODY')
  })

  it('falls back to http_<status> when the body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>', { status: 500 })))
    await expect(fetchCapabilities()).rejects.toMatchObject({ status: 500, code: 'http_500' })
  })

  it('rejects a 200 with a malformed body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(200, { nope: 1 })))
    await expect(fetchCapabilities()).rejects.toMatchObject({ code: 'bad_response' })
  })
})
