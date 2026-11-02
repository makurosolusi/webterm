// Guard sumber urutan boot: overlay env HARUS setelah writeTokenToEnv dan sebelum ledger/kanal
// membaca env. index.ts mengikat port, jadi tidak bisa diimpor di vitest (pola indexChannelsWiring).
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
const apiSource = readFileSync(new URL('./api.ts', import.meta.url), 'utf8')

describe('urutan boot env-settings', () => {
  it('overlay: setelah writeTokenToEnv, sebelum startLedgerRuntime/kanal/autonomy', () => {
    const at = (needle: string): number => source.indexOf(needle)
    const overlay = at('initEnvSettings()\n')
    expect(overlay).toBeGreaterThan(at('writeTokenToEnv(TOKEN)'))
    for (const later of ['startLedgerRuntime()', 'buildTelegramCentralPort(', 'startChannelsRuntime(', 'startCentralAutonomyBoot(']) {
      expect(overlay, later).toBeLessThan(at(later))
    }
  })

  it('rute env di-mount sebelum /api/settings dan sesudah gerbang (api.ts dipanggil setelah allowed)', () => {
    expect(apiSource.indexOf('ENV_SETTINGS_PATH) return')).toBeGreaterThan(-1)
    expect(apiSource.indexOf('ENV_SETTINGS_PATH) return')).toBeLessThan(apiSource.indexOf("path === '/api/settings'"))
  })
})
