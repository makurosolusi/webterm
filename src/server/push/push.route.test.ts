import { TEST_UI_COOKIE } from '../uiSession.testutil'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage } from 'node:http'
import { beforeEach, describe, expect, it } from 'vitest'
import { createFileSecretStore } from '../envSecrets.store'
import { pushRoute, type PushRouteDeps } from './push.route'
import { readPushState, vapidKeys, VAPID_SECRET_KEY } from './push.store'
import { fakeBrowser, recordingFetch } from './push.testutil'

const HOST = '127.0.0.1:8700'
const BROWSER = { host: HOST, origin: `http://${HOST}`, 'sec-fetch-site': 'same-origin', cookie: TEST_UI_COOKIE }
const NODE_TOKEN = 'n'.repeat(40) // test-only

let deps: PushRouteDeps
let statePath: string
let dir: string
let rec: ReturnType<typeof recordingFetch>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wt-push-route-'))
  statePath = join(dir, 'push-subscriptions.json')
  const secrets = createFileSecretStore(join(dir, 'secrets'))
  rec = recordingFetch()
  deps = { push: { statePath, keys: () => vapidKeys(secrets), fetch: rec.fetch, now: () => 1000 }, isNodeToken: (t) => t === NODE_TOKEN }
})

const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = BROWSER) =>
  pushRoute({ headers } as unknown as IncomingMessage, new URL(path, 'http://x'), method, async () => (body === undefined ? '' : JSON.stringify(body)), deps)

describe('pushRoute', () => {
  it('generates the VAPID key once and keeps it in the secret store', async () => {
    const a = await call('GET', '/api/push')
    const b = await call('GET', '/api/push')
    expect(a!.status).toBe(200)
    const key = (a!.body as { publicKey: string }).publicKey
    expect(key).toMatch(/^[A-Za-z0-9_-]{87}$/) // 65 bytes base64url
    expect((b!.body as { publicKey: string }).publicKey).toBe(key)
    expect(createFileSecretStore(join(dir, 'secrets')).read(VAPID_SECRET_KEY)).toContain('"d"')
  })

  it('is UI-only: agent credentials and non-browser callers get 403', async () => {
    const sub = (await fakeBrowser()).subscription()
    expect((await call('POST', '/api/push/subscribe', { subscription: sub }, { ...BROWSER, 'x-webterm-token': NODE_TOKEN }))!.body).toEqual({ error: 'agent_cannot_approve' })
    expect((await call('POST', '/api/push/subscribe', { subscription: sub }, { host: HOST }))!.body).toEqual({ error: 'approval_browser_only' })
    expect((await call('GET', '/api/push', undefined, { host: HOST }))!.status).toBe(403)
    expect(readPushState(statePath).subs).toEqual([])
  })

  it('subscribe / re-subscribe / unsubscribe', async () => {
    const sub = (await fakeBrowser()).subscription()
    expect(await call('POST', '/api/push/subscribe', { subscription: sub })).toEqual({ status: 200, body: { subscriptions: 1 } })
    expect(await call('POST', '/api/push/subscribe', { subscription: sub })).toEqual({ status: 200, body: { subscriptions: 1 } })
    expect(readPushState(statePath).subs[0]).toMatchObject({ endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth })
    expect(await call('POST', '/api/push/unsubscribe', { endpoint: sub.endpoint })).toEqual({ status: 200, body: { subscriptions: 0 } })
  })

  it('refuses endpoints that are not a push service (no server-side request to arbitrary URLs)', async () => {
    const b = await fakeBrowser()
    for (const endpoint of ['http://fcm.googleapis.com/x', 'https://127.0.0.1/x', 'https://evil.test/x', 'https://fcm.googleapis.com.evil.test/x', 'https://u:p@fcm.googleapis.com/x']) {
      expect((await call('POST', '/api/push/subscribe', { subscription: b.subscription(endpoint) }))!.body).toEqual({ error: 'invalid_subscription' })
    }
    expect((await call('POST', '/api/push/subscribe', { subscription: { endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'AA', auth: 'BB' } } }))!.status).toBe(400)
    expect((await call('POST', '/api/push/subscribe', { subscription: b.subscription('https://web.push.apple.com/abc') }))!.status).toBe(200)
  })

  it('test sends one notification to each device and needs a subscription first', async () => {
    expect((await call('POST', '/api/push/test'))!.status).toBe(409)
    const b = await fakeBrowser()
    await call('POST', '/api/push/subscribe', { subscription: b.subscription() })
    expect(await call('POST', '/api/push/test')).toEqual({ status: 200, body: { sent: 1 } })
    expect(await b.decrypt(rec.sent[0]!.body)).toEqual({ id: 'test:1000', kind: 'test', title: 'Test notification from webterm', url: '/m/#inbox' })
  })

  it('answers only its own paths and methods', async () => {
    expect(await call('GET', '/api/pushy')).toBeNull()
    expect((await call('POST', '/api/push'))!.status).toBe(405)
    expect((await call('GET', '/api/push/subscribe'))!.status).toBe(405)
    expect((await call('POST', '/api/push/nope'))!.status).toBe(404)
    expect((await call('POST', '/api/push/subscribe', 'not an object'))!.status).toBe(400)
  })
})
