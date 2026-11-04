import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildEnvState } from '../envSettings.state'
import { flag } from '../envRegistry.types'
import { configureLogging, createLogger, flushLogs } from '../logs/logger'
import { channelsMasterState } from './channelsMasterGate'

const chan = (v?: string) => channelsMasterState(v === undefined ? {} : { WEBTERM_TELEGRAM: v })

describe('dialek flag (L10)', () => {
  it('gerbang kanal (via telegram): 1/true/on on, 0/false/off/kosong/asing off', () => {
    expect([chan('1'), chan('TRUE'), chan('on')]).toEqual(['on', 'on', 'on'])
    expect([chan(), chan('0'), chan('false'), chan('off'), chan('maybe')]).toEqual(['off', 'off', 'off', 'off', 'off'])
  })

  it.each([['0', false], ['false', false], ['off', false], ['', true], ['on', true]])('WEBTERM_LOG_FILE=%j => sink %s', async (raw, written) => {
    const dir = mkdtempSync(join(tmpdir(), 'wt-dialect-'))
    try {
      configureLogging({ dir, console: false, env: { WEBTERM_LOG_FILE: raw } })
      createLogger('dialect').info('probe', 'probe')
      await flushLogs()
      expect(readdirSync(dir).some((f) => readFileSync(join(dir, f), 'utf8').includes('probe'))).toBe(written)
    } finally {
      configureLogging({ console: false, env: { WEBTERM_LOG_FILE: 'off' } })
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('dua kunci keamanan tetap === \'1\'', () => {
    for (const f of ['control/mount.ts', 'agentStatusAuth.ts']) {
      expect(readFileSync(join(__dirname, '..', f), 'utf8'), f).toContain("=== '1'")
    }
  })

  it('state env: flag dari env 1/true tampil on', () => {
    const base = { X_FLAG: '1' }
    const st = buildEnvState({ registry: [flag('X_FLAG', 'zzz', {} as never)], target: base, base, overrides: {}, fileSecrets: new Set(), bootEnv: undefined, locked: false, root: true })
    expect(st.entries[0]).toMatchObject({ value: 'on', valid: true })
  })
})
