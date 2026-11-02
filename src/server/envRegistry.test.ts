// Invarian registry: unik, tidak tumpang-tindih dengan bootstrap, default lolos validator sendiri.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { BOOTSTRAP_ONLY_KEYS, ENV_REGISTRY, ENV_SETTINGS_SWITCH, isBootstrapOnly, specFor } from './envRegistry'
import { validateEnvValue } from './envSettings.validate'
import type { EnvSpec } from './envRegistry.types'

const names = (f: (s: EnvSpec) => boolean): string[] => ENV_REGISTRY.filter(f).map((s) => s.key).sort()

describe('ENV_REGISTRY', () => {
  it('kunci unik dan tak ada yang bootstrap-only', () => {
    const keys = ENV_REGISTRY.map((s) => s.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const k of keys) expect(isBootstrapOnly(k)).toBe(false)
    expect(isBootstrapOnly(ENV_SETTINGS_SWITCH)).toBe(true)
    expect(BOOTSTRAP_ONLY_KEYS).toContain('WEBTERM_TELEGRAM_API_BASE')
  })

  it('kelas dangerous dan secret sesuai rancangan', () => {
    expect(names((s) => s.dangerous)).toEqual([
      'WEBTERM_CENTRAL_AUTONOMY', 'WEBTERM_CONTROL_CWD_ROOTS', 'WEBTERM_MEMORY_DIR', 'WEBTERM_OPENCODE_ALLOW_TOOLS',
      'WEBTERM_OPENCODE_BIN', 'WEBTERM_ORCHESTRATOR_RUN', 'WEBTERM_TRUST_PROXY',
    ])
    expect(names((s) => s.kind === 'secret')).toEqual(['WEBTERM_TELEGRAM_BOT_TOKEN', 'WEBTERM_TELEGRAM_WEBHOOK_SECRET'])
    expect(specFor('WEBTERM_CHANNEL_HMAC_SECRET')).toBeUndefined() // tak ada pembaca nilainya
    expect(specFor('WEBTERM_TELEGRAM_MODE')?.default).toBe('poll')
  })

  it('env log terdaftar dengan default, bukan secret, bukan bootstrap', () => {
    expect(specFor('WEBTERM_LOG_LEVEL')).toMatchObject({ kind: 'enum', default: 'info', dangerous: false })
    expect(specFor('WEBTERM_LOG_BUFFER')).toMatchObject({ kind: 'number', default: '5000', dangerous: false })
    expect(specFor('WEBTERM_LOG_FILE')).toMatchObject({ kind: 'flag', default: 'on', dangerous: false })
    expect(validateEnvValue(specFor('WEBTERM_LOG_BUFFER') as EnvSpec, '50').ok).toBe(false)
  })

  it('default non-secret lolos validatornya sendiri', () => {
    for (const s of ENV_REGISTRY) if (s.default !== undefined) expect(validateEnvValue(s, s.default), s.key).toMatchObject({ ok: true })
  })

  it('registry dipecah per domain: tiap file data <= 100 baris (Rule 8 config)', () => {
    for (const f of ['channels', 'central', 'platform', 'types']) {
      expect(readFileSync(new URL(`./envRegistry.${f}.ts`, import.meta.url), 'utf8').split('\n').length, f).toBeLessThanOrEqual(100)
    }
  })
})

describe('validateEnvValue number', () => {
  const spec = { key: 'X', group: 'central', kind: 'number', label: '', description: '', min: 1, max: 10, restartRequired: true, dangerous: false } as EnvSpec
  it('rentang dan bentuk', () => {
    expect(validateEnvValue(spec, '5')).toEqual({ ok: true, value: '5' })
    for (const bad of ['0', '11', 'abc', '', 'NaN', 5]) expect(validateEnvValue(spec, bad).ok).toBe(false)
  })
})
