// Control panel read model (F0-c): sources, reasons, secrets, mock badge, route gate, and the A2 drift test.
import { describe, expect, it } from 'vitest'
import { BOOTSTRAP_ONLY_KEYS, ENV_REGISTRY } from './envRegistry'
import { buildEffectiveConfig, type EffectiveRow } from './effectiveConfig'
import { CENTRAL_SECTION_KEYS, CENTRAL_SETTINGS, CONTROL_WHERE, uiWhere } from './effectiveConfig.ui'
import { SENTINEL_BOT_TOKEN, setupEnv } from './envSettings.testutil'

function build(env: NodeJS.ProcessEnv, stored: string | null = null, dotenv: string[] = []) {
  const s = setupEnv(env, stored)
  const out = buildEffectiveConfig({ state: s.svc.state({ root: true }), env: s.target, dotenvKeys: new Set(dotenv), bootstrapKeys: BOOTSTRAP_ONLY_KEYS })
  const row = (k: string): EffectiveRow => out.rows.find((r) => r.key === k) as EffectiveRow
  return { out, row }
}

describe('buildEffectiveConfig', () => {
  it('lists every registry key plus the WEBTERM_* bootstrap keys', () => {
    const { out } = build({})
    const keys = out.rows.map((r) => r.key)
    for (const s of ENV_REGISTRY) expect(keys).toContain(s.key)
    expect(keys).toContain('WEBTERM_TOKEN')
    expect(keys).not.toContain('HOST')
  })

  it('tells default, shell env, .env, Settings and capability sources apart', () => {
    const stored = JSON.stringify({ WEBTERM_CENTRAL: 'on', WEBTERM_CENTRAL_CHAT: 'on', WEBTERM_LOG_BUFFER: '900' })
    const { row } = build({ WEBTERM_LEDGER: 'shadow', WEBTERM_LOG_LEVEL: 'debug' }, stored, ['WEBTERM_LOG_LEVEL'])
    expect(row('WEBTERM_FILES_LIST_MAX')).toMatchObject({ source: 'default', modified: false, reason: 'Code default.', envOnly: false, ui: CONTROL_WHERE, editable: true })
    expect(row('WEBTERM_LEDGER')).toMatchObject({ source: 'env', value: 'shadow', modified: true })
    expect(row('WEBTERM_LOG_LEVEL')).toMatchObject({ source: '.env', value: 'debug', reason: 'From the .env file in the server folder.' })
    expect(row('WEBTERM_CENTRAL')).toMatchObject({ source: 'settings', value: 'on', ui: 'Settings › Capabilities › Central agent', envOnly: false })
    expect(row('WEBTERM_CENTRAL').reason).toBe('Set in Settings › Capabilities › Central agent.')
    expect(row('WEBTERM_CENTRAL_CHAT')).toMatchObject({ source: 'capability', reason: 'Derived from the Central agent card (Central agent on).' })
    expect(row('WEBTERM_LOG_BUFFER').reason).toBe('Set in Settings › Control.')
  })

  it('derived row names the card it follows (Worker card)', () => {
    const { row } = build({}, JSON.stringify({ WEBTERM_CENTRAL: 'on', WEBTERM_ORCHESTRATOR_RUN: 'on', WEBTERM_CENTRAL_TOOLS: 'write' }))
    expect(row('WEBTERM_CENTRAL_TOOLS')).toMatchObject({ source: 'capability', value: 'write' })
    expect(row('WEBTERM_CENTRAL_TOOLS').reason).toContain('Worker orchestrator card (Worker orchestrator on)')
  })

  it('secrets and bootstrap keys carry set/unset only, never a value', () => {
    const { out, row } = build({ WEBTERM_TELEGRAM_BOT_TOKEN: SENTINEL_BOT_TOKEN, WEBTERM_TOKEN: 'root-token-test-only' })
    expect(JSON.stringify(out)).not.toContain(SENTINEL_BOT_TOKEN)
    expect(JSON.stringify(out)).not.toContain('root-token-test-only')
    expect(row('WEBTERM_TELEGRAM_BOT_TOKEN')).toMatchObject({ secret: true, set: true, value: '' })
    expect(row('WEBTERM_TOKEN')).toMatchObject({ bootstrap: true, set: true, value: '', envOnly: true })
    expect(row('WEBTERM_DATA_DIR')).toMatchObject({ set: false, source: 'default' })
  })

  it('raises the MOCK badge only when a runtime resolves to the mock engine', () => {
    expect(build({}).out.mock).toEqual({ active: false, keys: [] })
    const { out, row } = build({ WEBTERM_CENTRAL_RUNTIME: 'mock' })
    expect(out.mock).toEqual({ active: true, keys: ['WEBTERM_CENTRAL_RUNTIME'] })
    expect(row('WEBTERM_CENTRAL_RUNTIME')).toMatchObject({ mock: true, value: 'mock' })
    expect(row('WEBTERM_CENTRAL_RUNTIME').reason).toMatch(/^MOCK:/)
  })

  it('unset runtime shows what auto-detect resolves to, never mock', () => {
    const { row } = build({ PATH: '' })
    expect(row('WEBTERM_CENTRAL_RUNTIME').value).toBe('auto (off)')
    expect(row('WEBTERM_CENTRAL_RUNTIME').mock).toBeUndefined()
  })
})

describe('A2 drift: no behaviour key is env-only (F1 exit)', () => {
  it('every registry key has a UI location; only bootstrap keys are env-only', () => {
    expect(ENV_REGISTRY.filter((s) => !uiWhere(s.key)).map((s) => s.key)).toEqual([])
    const { out } = build({})
    expect(out.rows.filter((r) => r.envOnly).every((r) => r.bootstrap)).toBe(true)
  })
})

describe('Central Agent section keys', () => {
  it('live in Settings › Central Agent under their registry label and are read-only in Control', () => {
    const { row } = build({})
    expect(CENTRAL_SECTION_KEYS).toHaveLength(14)
    for (const k of CENTRAL_SECTION_KEYS) {
      expect(row(k), k).toMatchObject({ ui: `${CENTRAL_SETTINGS} › ${row(k).label}`, editable: false })
    }
    expect(row('WEBTERM_CENTRAL_DAILY_COST_MICROS').ui).toBe('Settings › Central Agent › Daily spending limit')
    // Derived keys keep following their card.
    expect(row('WEBTERM_CENTRAL_CHAT').ui).toBe('Settings › Capabilities › Central agent (derived)')
  })

  it('Central labels avoid internal jargon', () => {
    const { out } = build({})
    const central = out.rows.filter((r) => r.key.startsWith('WEBTERM_CENTRAL') || CENTRAL_SECTION_KEYS.includes(r.key))
    for (const r of central) expect(r.label, r.key).not.toMatch(/micros|candidate|\(ms\)|\bL[0-4]\b/i)
  })

  it('the mock engine stays a valid value but is never offered as an option', () => {
    expect(build({}).row('WEBTERM_CENTRAL_RUNTIME').options).toEqual(['claude', 'off'])
    expect(build({ WEBTERM_CENTRAL_RUNTIME: 'mock' }).row('WEBTERM_CENTRAL_RUNTIME')).toMatchObject({ value: 'mock', valid: true })
  })
})

describe('Control locks (explicit env wins, VS Code policy pattern)', () => {
  it('shell env locks a Control row with the reason; .env and defaults stay editable', () => {
    const { row } = build({ WEBTERM_LOG_LEVEL: 'debug', WEBTERM_LOG_BUFFER: '900' }, null, ['WEBTERM_LOG_BUFFER'])
    expect(row('WEBTERM_LOG_LEVEL')).toMatchObject({ editable: false, restart: 'boot' })
    expect(row('WEBTERM_LOG_LEVEL').lockReason).toContain('shell environment')
    expect(row('WEBTERM_LOG_BUFFER')).toMatchObject({ editable: true, source: '.env' })
    expect(row('WEBTERM_AGENT_SANDBOX')).toMatchObject({ editable: true, restart: 'hot', kind: 'flag', setting: 'on' })
  })

  it('card-owned and derived keys are not editable here; global lock and bootstrap keys carry a reason', () => {
    const { row } = build({})
    expect(row('WEBTERM_CENTRAL')).toMatchObject({ editable: false, ui: 'Settings › Capabilities › Central agent' })
    expect(row('WEBTERM_CENTRAL').lockReason).toBeUndefined()
    expect(row('WEBTERM_TOKEN')).toMatchObject({ editable: false, bootstrap: true })
    const locked = build({ WEBTERM_ENV_SETTINGS: 'off' }).row('WEBTERM_FILES_LIST_MAX')
    expect(locked.editable).toBe(false)
    expect(locked.lockReason).toContain('WEBTERM_ENV_SETTINGS=off')
  })
})
