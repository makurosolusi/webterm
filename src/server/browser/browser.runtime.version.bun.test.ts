// Bun-only: status().version di runtime utuh di atas CDP tiruan (hanya hadir saat ada node live; satu panggilan CDP).
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'
import type { AddressInfo } from 'node:net'
import { ENV_BROWSER } from '../../shared/browser.contract'
import type { Workspace } from '../../shared/workspace'
import { CapabilityStore } from '../control/capabilities'
import { createFileSecretStore } from '../envSecrets.store'
import { startBrowserRuntime } from './browser.runtime'
import { startFakeCdp } from './fakeCdp.testkit'

const WS: Workspace = {
  id: 'w1', name: 'w', cwd: '/', viewport: { x: 0, y: 0, zoom: 1 }, bridges: [], updatedAt: 0,
  nodes: [{ id: 'b1', kind: 'browser', x: 0, y: 0, url: 'https://example.com/' }],
}
const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const c of cleanup.splice(0).reverse()) await c() })
const until = async (cond: () => boolean) => { for (let i = 0; i < 300 && !cond(); i++) await new Promise((r) => setTimeout(r, 10)); expect(cond()).toBe(true) }

test('version absen sebelum browser hidup, terisi sekali setelah node live, kosong lagi setelah node discard', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wt-brver-'))
  const fake = await startFakeCdp()
  fake.handle('Browser.getVersion', () => ({ product: 'Chrome/131.0.1' }))
  const rt = await startBrowserRuntime({
    env: { [ENV_BROWSER.enabled]: 'on' }, webtermPort: 8700, dataRoot: dir, secrets: createFileSecretStore(join(dir, 'secrets')),
    capabilities: new CapabilityStore(), workspaces: () => [WS], launcher: { acquire: async () => fake.url, shutdown: () => undefined },
  })
  if (!rt) throw new Error('runtime tidak menyala')
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>((r) => wss.once('listening', () => r()))
  wss.on('connection', (ws) => rt.gateway(ws, 'w1'))
  const client = new WebSocket(`ws://127.0.0.1:${(wss.address() as AddressInfo).port}/`)
  cleanup.push(async () => { client.terminate(); await new Promise<void>((r) => wss.close(() => r())); await rt.shutdown(); await fake.close(); rmSync(dir, { recursive: true, force: true }) })
  await new Promise<void>((r) => client.once('open', () => r()))

  expect(rt.status().version).toBe(undefined)
  client.send(JSON.stringify({ t: 'attach', id: 'b1', w: 800, h: 600, dpr: 1 }))
  await until(() => rt.status().live === 1 && rt.status().version === 'Chrome/131.0.1')
  for (let i = 0; i < 5; i++) rt.status()
  expect(fake.methods().filter((m) => m === 'Browser.getVersion').length).toBe(1)
  expect('userAgent' in rt.status()).toBe(false)

  fake.drop() // koneksi putus: node crash -> discarded -> tak ada browser hidup
  await until(() => rt.status().live === 0)
  expect(rt.status().version).toBe(undefined)
})
