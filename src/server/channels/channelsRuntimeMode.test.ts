import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SecretStore } from '../envSecrets.store'
import { startChannelsRuntime, TELEGRAM_WEBHOOK_PATH } from './channelsRuntime'
import { callApi, cleanTempStores, harnessLedger, tempStorePath } from './channelsRuntimeHarness'
import { recordIngress, resetChannelStatus } from './channelStatus'
import { TELEGRAM_STATUS_PATH } from './channelStatusHttp'

const SECRET = 'webhook-secret-for-tests-0123456789'
const TOKEN = '123456:AAFakeBotTokenForStatusTests_xyz'
const BASE = { WEBTERM_TELEGRAM: 'on' }

// Store in-memori: secret webhook otomatis tak boleh menulis ke data dir sungguhan.
const memStore = new Map<string, string>()
const secrets: SecretStore = {
  read: (key) => memStore.get(key) ?? null,
  write: (key, value) => void memStore.set(key, value),
  remove: (key) => void memStore.delete(key),
}

function start(extra: Record<string, string>) {
  return startChannelsRuntime(harnessLedger(), {
    env: { ...BASE, ...extra } as NodeJS.ProcessEnv,
    storePath: tempStorePath(),
    secrets,
    sender: { intervalMs: 60_000 },
  })
}

function webhookHit(channels: { handle(req: IncomingMessage, res: ServerResponse): boolean }): boolean {
  const req = new EventEmitter() as unknown as IncomingMessage
  Object.assign(req, { method: 'POST', url: TELEGRAM_WEBHOOK_PATH, headers: {}, socket: { remoteAddress: '127.0.0.1' } })
  const res = { headersSent: false, statusCode: 0, setHeader: () => undefined, end: () => undefined } as unknown as ServerResponse
  const handled = channels.handle(req, res)
  req.emit('end')
  return handled
}

let warn: { mock: { calls: unknown[][] } }
beforeEach(() => {
  memStore.clear()
  resetChannelStatus()
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
})
afterEach(() => {
  vi.restoreAllMocks()
  cleanTempStores()
})

describe('startChannelsRuntime mode gating', () => {
  it('poll mode starts with a bot token and no webhook secret, and installs no webhook route', () => {
    const channels = start({ WEBTERM_TELEGRAM_MODE: 'poll', WEBTERM_TELEGRAM_BOT_TOKEN: TOKEN })
    expect(channels).not.toBeNull()
    expect(channels?.mode).toBe('poll')
    expect(webhookHit(channels!)).toBe(false)
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).not.toContain('disabled')
    channels?.stop()
  })

  it('poll mode without a bot token logs exactly one clear warning and does not crash', () => {
    const channels = start({ WEBTERM_TELEGRAM_MODE: 'poll' })
    expect(channels).not.toBeNull()
    const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('bot token belum diset'))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('telegram on tetapi bot token belum diset')
    channels?.stop()
  })

  it('explicit webhook mode without a secret generates one into the secret store and installs the route (KE-9)', () => {
    const channels = start({ WEBTERM_TELEGRAM_MODE: 'webhook', WEBTERM_TELEGRAM_BOT_TOKEN: TOKEN })
    expect(channels?.mode).toBe('webhook')
    expect(webhookHit(channels!)).toBe(true)
    expect(memStore.get('WEBTERM_TELEGRAM_WEBHOOK_SECRET')).toMatch(/^[A-Za-z0-9_-]{32,256}$/)
    expect(JSON.stringify(warn.mock.calls)).not.toContain(memStore.get('WEBTERM_TELEGRAM_WEBHOOK_SECRET'))
    channels?.stop()
    // Dijalankan ulang: secret yang sama dipakai, tidak dibangkitkan lagi.
    const first = memStore.get('WEBTERM_TELEGRAM_WEBHOOK_SECRET')
    start({ WEBTERM_TELEGRAM_MODE: 'webhook' })?.stop()
    expect(memStore.get('WEBTERM_TELEGRAM_WEBHOOK_SECRET')).toBe(first)
  })

  it('webhook mode with a configured secret installs the route', () => {
    const channels = start({ WEBTERM_TELEGRAM_MODE: 'webhook', WEBTERM_TELEGRAM_WEBHOOK_SECRET: SECRET })
    expect(channels?.mode).toBe('webhook')
    expect(webhookHit(channels!)).toBe(true)
    expect(memStore.size).toBe(0)
    channels?.stop()
  })

  it('with no mode, no token and no secret it waits in poll mode (no webhook, no generated secret)', () => {
    const waiting = start({})
    expect(waiting?.mode).toBe('poll')
    expect(webhookHit(waiting!)).toBe(false)
    expect(memStore.size).toBe(0)
    waiting?.stop()
    expect(start({ WEBTERM_TELEGRAM_WEBHOOK_SECRET: SECRET })?.mode).toBe('webhook')
  })
})

describe('GET /api/channels/telegram/status', () => {
  it('reports presence booleans, pending count and ingress/egress, never secret values', async () => {
    const channels = start({ WEBTERM_TELEGRAM_MODE: 'poll', WEBTERM_TELEGRAM_BOT_TOKEN: TOKEN })!
    await channels.ingest({ update_id: 1, message: { message_id: 1, text: 'hi', chat: { id: 77, type: 'private' }, from: { id: 77 } } })
    recordIngress({ ok: false, at: 5, error: `getUpdates failed for bot${TOKEN} ${'x'.repeat(500)}` })
    recordIngress({ ok: true, at: 9 })

    const res = await callApi(channels, 'GET', TELEGRAM_STATUS_PATH)
    expect(res.status).toBe(200)
    const body = JSON.parse(res.body)
    expect(body).toMatchObject({
      mode: 'poll',
      enabled: true,
      botTokenSet: true,
      webhookSecretSet: false,
      pendingCount: 1,
      ingress: { okCount: 1, errorCount: 1, lastOk: 9 },
      egress: { okCount: 0, errorCount: 0 },
    })
    expect(body.ingress.lastError.message.length).toBeLessThanOrEqual(300)
    expect(res.body).not.toContain(TOKEN)
    channels.stop()
  })

  it('treats a readable secret file as set, and answers 405 for non-GET', async () => {
    const root = mkdtempSync(join(tmpdir(), 'webterm-status-'))
    try {
      const file = join(root, 'secret')
      writeFileSync(file, `${SECRET}\n`, { mode: 0o600 })
      chmodSync(file, 0o600)
      const channels = start({ WEBTERM_TELEGRAM_WEBHOOK_SECRET_FILE: file })!
      const body = JSON.parse((await callApi(channels, 'GET', TELEGRAM_STATUS_PATH)).body)
      expect(body).toMatchObject({ mode: 'webhook', botTokenSet: false, webhookSecretSet: true })
      expect((await callApi(channels, 'POST', TELEGRAM_STATUS_PATH)).status).toBe(405)
      expect((await callApi(channels, 'GET', `${TELEGRAM_STATUS_PATH}/x`)).handled).toBe(false)
      channels.stop()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
