// Body intake `/api/settings`: hanya PUT yang membaca stream, dan cap 64 KiB ditegakkan saat
// streaming. Store di-inject (bukan singleton `db`) supaya suite node-env ini tidak menarik
// `bun:sqlite`.
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Settings } from '../shared/settings'
import { SETTINGS_BODY_MAX_BYTES } from './cappedRequestBody'
import { settingsRoute, type SettingsStore } from './settingsApi'
import { nextSettings, nextSettingsDocument } from './settingsStore'

const CAP = SETTINGS_BODY_MAX_BYTES

const SNAPSHOT = { scrollbackBytes: 2000 } as unknown as Settings

function fakeStore(): SettingsStore & { saves: unknown[] } {
  const saves: unknown[] = []
  return {
    saves,
    getSettings: () => SNAPSHOT,
    saveSettings: (patch: unknown) => {
      saves.push(patch)
      return SNAPSHOT
    },
  }
}

interface TrackedReq extends IncomingMessage {
  dataSubscriptions: number
  resumes: number
}

/** Request palsu berbentuk stream Node (yang dibaca `readCappedBody`). */
function trackedReq(method: string, headers: Record<string, string> = {}): TrackedReq {
  const req = new EventEmitter() as unknown as TrackedReq
  const on = req.on.bind(req)
  Object.assign(req, { method, headers, dataSubscriptions: 0, resumes: 0 })
  ;(req as unknown as { on: typeof on }).on = (event: string, listener: (...a: unknown[]) => void) => {
    if (event === 'data') req.dataSubscriptions += 1
    return on(event, listener)
  }
  ;(req as unknown as { resume: () => void }).resume = () => { req.resumes += 1 }
  return req
}

interface RecordedRes extends ServerResponse { status: number; body: string; json(): unknown }

function recorder(): RecordedRes {
  const res = {
    status: 0,
    body: '',
    headersSent: false,
    setHeader: () => undefined,
    end: (chunk?: string) => { if (chunk) res.body += chunk },
    json: () => JSON.parse(res.body) as unknown,
  }
  Object.defineProperty(res, 'statusCode', { get: () => res.status, set: (v: number) => { res.status = v } })
  return res as unknown as RecordedRes
}

function feed(req: IncomingMessage, chunks: string[], then: 'end' | 'error' = 'end'): void {
  process.nextTick(() => {
    for (const chunk of chunks) req.emit('data', Buffer.from(chunk))
    if (then === 'end') req.emit('end')
    else req.emit('error', new Error('socket hang up'))
  })
}

/** JSON sah sepanjang TEPAT `targetBytes` byte (spasi ekor diabaikan `JSON.parse`). */
function jsonOfSize(value: unknown, targetBytes: number): string {
  const json = JSON.stringify(value)
  return json + ' '.repeat(targetBytes - json.length)
}

describe('GET /api/settings', () => {
  it('mengembalikan snapshot tanpa menyentuh stream request', async () => {
    const store = fakeStore()
    const req = trackedReq('GET')
    const res = recorder()
    await settingsRoute(req, res, 'GET', store)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(SNAPSHOT)
    expect(req.dataSubscriptions).toBe(0)
    expect(req.resumes).toBe(0)
  })
})

describe('POST /api/settings', () => {
  it('tetap 405 dan tidak membaca body', async () => {
    const store = fakeStore()
    const req = trackedReq('POST')
    const res = recorder()
    await settingsRoute(req, res, 'POST', store)
    expect(res.statusCode).toBe(405)
    expect(res.json()).toEqual({ error: 'method not allowed' })
    expect(req.dataSubscriptions).toBe(0)
    expect(store.saves).toEqual([])
  })
})

describe('PUT /api/settings dengan cap', () => {
  it('body chunked di atas cap dijawab 413 dan patch tidak disimpan', async () => {
    const store = fakeStore()
    const req = trackedReq('PUT')
    feed(req, [jsonOfSize({ scrollbackBytes: 1 }, CAP + 1)])
    const res = recorder()
    await settingsRoute(req, res, 'PUT', store)
    expect(res.statusCode).toBe(413)
    expect(res.json()).toEqual({ error: 'payload_too_large' })
    expect(store.saves).toEqual([])
  })

  it('Content-Length di atas cap ditolak sebelum satu byte dibaca', async () => {
    const store = fakeStore()
    const req = trackedReq('PUT', { 'content-length': String(CAP + 1) })
    const res = recorder()
    await settingsRoute(req, res, 'PUT', store)
    expect(res.statusCode).toBe(413)
    expect(res.json()).toEqual({ error: 'payload_too_large' })
    expect(req.dataSubscriptions).toBe(0)
    expect(req.resumes).toBe(1)
    expect(store.saves).toEqual([])
  })

  it('body tepat sebesar cap tetap tersimpan', async () => {
    const store = fakeStore()
    const body = jsonOfSize({ scrollbackBytes: 4096 }, CAP)
    expect(Buffer.byteLength(body)).toBe(CAP)
    const req = trackedReq('PUT', { 'content-length': String(CAP) })
    feed(req, [body.slice(0, 4096), body.slice(4096)])
    const res = recorder()
    await settingsRoute(req, res, 'PUT', store)
    expect(res.statusCode).toBe(200)
    expect(store.saves).toEqual([{ scrollbackBytes: 4096 }])
  })

  it('stream error jadi 400 body_read_failed', async () => {
    const store = fakeStore()
    const req = trackedReq('PUT')
    feed(req, ['{"scrollbackBytes":1}'], 'error')
    const res = recorder()
    await settingsRoute(req, res, 'PUT', store)
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'body_read_failed' })
    expect(store.saves).toEqual([])
  })

  it('JSON rusak di bawah cap tetap 400 bad json (perilaku lama)', async () => {
    const store = fakeStore()
    const req = trackedReq('PUT')
    feed(req, ['{nope'])
    const res = recorder()
    await settingsRoute(req, res, 'PUT', store)
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'bad json' })
    expect(store.saves).toEqual([])
  })

  it('body sah yang kecil tersimpan seperti sebelumnya', async () => {
    const store = fakeStore()
    const req = trackedReq('PUT')
    feed(req, ['{"scrollbackBytes":3000}'])
    const res = recorder()
    await settingsRoute(req, res, 'PUT', store)
    expect(res.statusCode).toBe(200)
    expect(store.saves).toEqual([{ scrollbackBytes: 3000 }])
  })
})

// `vi` dipakai hanya untuk memastikan tidak ada panggilan tulis yang lolos tanpa assertion.
describe('tidak ada efek samping diam-diam', () => {
  it('saveSettings tidak pernah dipanggil saat intake menolak', async () => {
    const store = fakeStore()
    const spy = vi.spyOn(store, 'saveSettings')
    const req = trackedReq('PUT', { 'content-length': String(CAP * 4) })
    await settingsRoute(req, recorder(), 'PUT', store)
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('PUT /api/settings customAgents strict', () => {
  it('entri rusak => 400 invalid_settings + galat per field; nilai tidak dipantulkan', async () => {
    const store: SettingsStore = { getSettings: () => SNAPSHOT, saveSettings: (p) => (nextSettings(null, p), SNAPSHOT) }
    const req = trackedReq('PUT')
    feed(req, [JSON.stringify({ customAgents: [{ id: 'custom:x', label: 'X', launchCmd: '', env: { MY_TOKEN: 'sekrit-value' } }] })])
    const res = recorder()
    await settingsRoute(req, res, 'PUT', store)
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'invalid_settings', errors: [{ index: 0, field: 'env.MY_TOKEN', code: 'secret_literal' }] })
    expect(res.body).not.toContain('sekrit-value')
  })

  it('inputHistory not in stored form => 400 invalid_settings; the value is not echoed', async () => {
    const store: SettingsStore = { getSettings: () => SNAPSHOT, saveSettings: (p) => (nextSettings(null, p), SNAPSHOT) }
    const req = trackedReq('PUT')
    feed(req, [JSON.stringify({ inputHistory: { 'claude.gatewayUrl': ['  https://remembered.example  '] } })]) // test-only
    const res = recorder()
    await settingsRoute(req, res, 'PUT', store)
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'invalid_settings', errors: [{ index: 0, field: 'inputHistory.list', code: 'invalid_list' }] })
    expect(res.body).not.toContain('remembered.example')
  })

  it('deleting a launch profile still in use => 409 profile_in_use with the reason', async () => {
    const stored = JSON.stringify({ claudeLaunchProfiles: [{ id: 'em', name: 'E', command: 'claude' }] })
    const store: SettingsStore = { getSettings: () => SNAPSHOT, saveSettings: (p) => (nextSettingsDocument(stored, p, { providerProfileId: 'em' }), SNAPSHOT) }
    const req = trackedReq('PUT')
    feed(req, [JSON.stringify({ claudeLaunchProfiles: [{ id: 'em', deleted: true }] })])
    const res = recorder()
    await settingsRoute(req, res, 'PUT', store)
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: 'profile_in_use', profileId: 'em', reason: 'provider' })
  })

  it('galat non-validasi tetap dilempar ke pemanggil', async () => {
    const store: SettingsStore = { getSettings: () => SNAPSHOT, saveSettings: () => { throw new Error('disk') } }
    const req = trackedReq('PUT')
    feed(req, ['{}'])
    await expect(settingsRoute(req, recorder(), 'PUT', store)).rejects.toThrow('disk')
  })
})
