// Boot kemampuan (ES-09) tanpa mengikat port: store kosong tidak menyalakan apa pun, dan browser bisa
// on lalu off lewat rute tanpa restart. Peluncur + CDP TIRUAN; data dir dan HOME sementara di /tmp.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { IncomingMessage } from 'node:http'
import { expect, test } from 'bun:test'
import { activeBrowser, registerBrowserCapability, stopBrowser } from './browser/browser.activate'
import { startFakeCdp, type FakeCdp } from './browser/fakeCdp.testkit'
import { createTelegramHot, registerTelegramHot } from './channels/telegramHot'
import { envSettingsApiDeps } from './envSettings.runtime'
import { capabilitiesRoute } from './featureCapabilities.api'
import { enabledSet, reconcile } from './featureCapabilities.runtime'
import { recorder } from './envSettings.testutil'

const ORIGIN = 'http://127.0.0.1:8700'
const saved = { ...process.env }

async function post(path: string, body: unknown): Promise<number> {
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
    method: 'POST', headers: { host: '127.0.0.1:8700', origin: ORIGIN }, socket: { remoteAddress: '127.0.0.1' },
  }) as unknown as IncomingMessage
  const res = recorder()
  await capabilitiesRoute(req, res, 'POST', path, envSettingsApiDeps, { detect: () => ({ chromium: true, telegramToken: false, agentEngine: true }) })
  return res.status
}

test('store kosong tidak memulai browser maupun poller; browser on lalu off tanpa restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wt-capboot-'))
  for (const k of Object.keys(process.env)) if (k.startsWith('WEBTERM_') || k === 'PORT') delete process.env[k]
  Object.assign(process.env, { WEBTERM_DATA_DIR: dir, HOME: dir })
  const fake: FakeCdp = await startFakeCdp()
  const telegram = createTelegramHot({ ledger: () => undefined })
  const off = [
    registerBrowserCapability({
      env: process.env, webtermPort: 8700, dataRoot: dir, secrets: { read: () => undefined, write: () => undefined, remove: () => undefined } as never,
      workspaces: () => [],
      launcher: { acquire: async () => fake.url, shutdown: () => undefined },
    }),
    registerTelegramHot(telegram),
  ]
  try {
    envSettingsApiDeps() // overlay dari store kosong
    await reconcile(new Set(), enabledSet(process.env))
    expect(activeBrowser()).toBeNull()
    expect(telegram.channels).toBeNull()

    expect(await post('/api/capabilities/browser', { enabled: true })).toBe(200)
    expect(activeBrowser()).not.toBeNull()
    expect(await post('/api/capabilities/browser', { enabled: false })).toBe(200)
    expect(activeBrowser()).toBeNull()
    expect(telegram.channels).toBeNull()
  } finally {
    off.forEach((f) => f())
    await stopBrowser()
    await fake.close()
    for (const k of Object.keys(process.env)) delete process.env[k]
    Object.assign(process.env, saved)
    rmSync(dir, { recursive: true, force: true })
  }
})
