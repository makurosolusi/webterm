// Guard sumber urutan boot: overlay env HARUS setelah writeTokenToEnv dan sebelum ledger/kanal
// membaca env. index.ts mengikat port, jadi tidak bisa diimpor di vitest (pola indexChannelsWiring).
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./server.main.ts', import.meta.url), 'utf8')
// Rute env tinggal di tabel route ber-urutan (routes/settings.routes.ts); urutan penuh dijaga apiRoutes.bun.test.ts.
const apiSource = readFileSync(new URL('./routes/settings.routes.ts', import.meta.url), 'utf8')

describe('urutan boot env-settings', () => {
  it('overlay: setelah writeTokenToEnv, sebelum startLedgerRuntime/kanal/autonomy', () => {
    const at = (needle: string): number => source.indexOf(needle)
    const overlay = at('initEnvSettings()\n')
    // writeTokenToEnv dipanggil di dalam bootWiring (bootWiring.ts); index.ts hanya memanggil bootWiring.
    expect(at('bootWiring(process.env')).toBeGreaterThan(-1)
    expect(overlay).toBeGreaterThan(at('bootWiring(process.env'))
    for (const later of ['startLedgerRuntime()', 'createTelegramHot(', 'registerTelegramHot(', 'startCentralAutonomyBoot(']) {
      expect(overlay, later).toBeLessThan(at(later))
    }
  })

  it('rute env di-mount sebelum /api/settings dan sesudah gerbang (api.ts dipanggil setelah allowed)', () => {
    expect(apiSource.indexOf('c.path === ENV_SETTINGS_PATH')).toBeGreaterThan(-1)
    expect(apiSource.indexOf('c.path === ENV_SETTINGS_PATH')).toBeLessThan(apiSource.indexOf("c.path === '/api/settings'"))
  })
})
