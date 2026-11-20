// Boot hook: the endpoint source is connected once the proxy listens, stop drops it (fail closed again),
// and a taken port produces the "need a restart" notice text.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'wt-cpboot-'))
process.env.WEBTERM_DATA_DIR = join(dir, 'data') // importing the store/db modules must never touch the real data dir
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const { bootCredentialProxy, portChangedText, shutdownCredentialProxy } = await import('./credentialProxy.boot')
const { proxyEndpoint, requireProxy } = await import('./credentialProxy.env')

describe('bootCredentialProxy', () => {
  beforeAll(() => { expect(proxyEndpoint()).toBeNull() })

  test('start connects the endpoint source; shutdown makes spawns fail closed again', async () => {
    const e = bootCredentialProxy({ dataDir: join(dir, 'proxy'), runningSessions: () => 0, notice: { db: null } })
    expect(e?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(requireProxy()).toEqual(e as NonNullable<typeof e>)
    await shutdownCredentialProxy()
    expect(proxyEndpoint()).toBeNull()
    let msg = ''
    try { requireProxy() } catch (err) { msg = (err as Error).message }
    expect(msg).toBe('credential_proxy_unavailable')
  })

  test('the port-change notice names the count', () => {
    expect(portChangedText(1)).toBe('1 running agent session points at the old proxy address and needs a restart.')
    expect(portChangedText(3)).toBe('3 running agent sessions point at the old proxy address and need a restart.')
  })
})
