// Handlers and gate of the maintainer diagnosis capabilities: fakes in, scrubbed and byte-capped answers out.
import { describe, expect, test } from 'vitest'
import type { Workspace } from '../../shared/workspace'
import type { DoctorCheck } from '../doctor'
import type { EffectiveRow } from '../effectiveConfig'
import { buildAgentContext, TOOL_INDEX } from '../cli/cli.registry'
import { isMaintainerNode, MAINTAINER_CAPABILITIES, MAINTAINER_CAPABILITY_NAMES, maintainerByDefault } from './maintainer.capabilities'
import { configReadResult, doctorRunResult, instanceInfoResult, MAINTAINER_MAX_BYTES } from './maintainer.run'

const SECRET = 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789' // test-only
const row = (over: Partial<EffectiveRow>): EffectiveRow => ({
  key: 'WEBTERM_X', label: 'X', description: '', subsystem: 'Files', kind: 'flag', value: 'on', secret: false, source: 'default', reason: '', modified: false,
  ui: null, envOnly: false, pendingRestart: false, valid: true, editable: true, restart: 'none', setting: '', ...over,
})
const check = (over: Partial<DoctorCheck>): DoctorCheck => ({ id: 'claude', title: 'Claude', status: 'ok', detail: 'fine', ...over })
const ws = (preset?: 'maintainer'): Workspace => ({ id: 'w', nodes: [{ id: 'n1', ...(preset ? { preset } : {}) }] } as unknown as Workspace)

describe('doctor.run', () => {
  test('returns structured checks with a status summary, and a masked secret in a finding', () => {
    const out = doctorRunResult([check({}), check({ id: 'telegram', status: 'fail', detail: `bad token ${SECRET}`, go: { field: 'TELEGRAM' } })], {})
    expect(out.summary).toEqual({ ok: 1, fail: 1 })
    expect(JSON.stringify(out)).not.toContain(SECRET)
    expect(out.checks).toHaveLength(2)
  })
  test('one id filters; an unknown id is an error, not an empty ok', () => {
    expect(doctorRunResult([check({}), check({ id: 'tmux' })], { id: 'tmux' }).checks).toHaveLength(1)
    expect(doctorRunResult([check({})], { id: 'nope' }).error).toBe('unknown_check')
  })
  test('the answer stays under the byte cap', () => {
    const many = Array.from({ length: 400 }, () => check({ detail: 'x'.repeat(300) }))
    const out = doctorRunResult(many, {})
    expect(Buffer.byteLength(JSON.stringify(out.checks))).toBeLessThanOrEqual(MAINTAINER_MAX_BYTES)
    expect(out.truncated).toBe(true)
  })
})

describe('config.read', () => {
  test('a secret key and a bootstrap key never return a value, only set/unset', () => {
    const out = configReadResult([row({ key: 'WEBTERM_BOT_TOKEN', secret: true, value: SECRET, set: true, default: SECRET }), row({ key: 'WEBTERM_BOOT', bootstrap: true, value: 'hunter2', set: false }), row({})], {})
    const text = JSON.stringify(out)
    expect(text).not.toContain(SECRET)
    expect(text).not.toContain('hunter2')
    expect(out.rows[0]).toMatchObject({ key: 'WEBTERM_BOT_TOKEN', set: true })
    expect(out.rows[1]).toMatchObject({ key: 'WEBTERM_BOOT', set: false })
    expect(out.rows[2]).toMatchObject({ key: 'WEBTERM_X', value: 'on', source: 'default' })
  })
  test('a non-secret value that embeds a credential is still masked', () => {
    const out = configReadResult([row({ value: `Bearer ${SECRET}` })], {})
    expect(JSON.stringify(out)).not.toContain(SECRET)
  })
  test('q filters, limit caps and truncated says so; the byte cap holds', () => {
    const rows = Array.from({ length: 300 }, (_, i) => row({ key: `WEBTERM_K${i}`, value: 'v'.repeat(250) }))
    expect(configReadResult(rows, { q: 'k29' }).matched).toBe(11)
    const capped = configReadResult(rows, { limit: 3 })
    expect(capped.rows).toHaveLength(3)
    expect(capped.truncated).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(configReadResult(rows, {}).rows))).toBeLessThanOrEqual(MAINTAINER_MAX_BYTES)
  })
})

describe('instance.info', () => {
  test('reports facts and a boolean for the data dir, never its path', () => {
    const out = instanceInfoResult({ version: '1.2.3', production: true, platform: 'linux', dataDirPresent: true, uptimeSec: 12.6, sessions: 2, nodes: 5, browser: { enabled: true } })
    expect(out).toMatchObject({ version: '1.2.3', mode: 'production', platform: 'linux', dataDirPresent: true, uptimeSec: 13, sessions: 2, nodes: 5 })
    expect(JSON.stringify(out)).not.toMatch(/\/(home|Users|root)\//)
  })
})

describe('gate', () => {
  test('only a node stored with the maintainer preset passes; a node cannot claim it', () => {
    expect(isMaintainerNode([ws('maintainer')], 'n1')).toBe(true)
    expect(isMaintainerNode([ws()], 'n1')).toBe(false)
    expect(isMaintainerNode([ws('maintainer')], 'other')).toBe(false)
  })
  test('all three are R0, global, idempotent and registered in the one tool index', () => {
    expect(MAINTAINER_CAPABILITIES.map((c) => c.name)).toEqual([...MAINTAINER_CAPABILITY_NAMES])
    for (const c of MAINTAINER_CAPABILITIES) {
      expect([c.tier, c.scope, c.idempotent]).toEqual(['R0', 'global', true])
      expect(TOOL_INDEX.get(c.name)).toBe(c)
    }
  })
  test('the builtin grant is for node principals only and agent-context shows the rule to a maintainer only', () => {
    expect(maintainerByDefault('human-ui')).toEqual([])
    expect(maintainerByDefault('node:n1').map((g) => g.capability)).toEqual([...MAINTAINER_CAPABILITY_NAMES])
    expect(buildAgentContext('node:n1', () => 'allow', undefined, true).rule).toContain('logs.summary, doctor.run, config.read, instance.info')
    expect(buildAgentContext('node:n1', () => 'allow').rule).toBeUndefined()
  })
})
