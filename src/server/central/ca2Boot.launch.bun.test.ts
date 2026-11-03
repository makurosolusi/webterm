import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGENT_CONFIG } from '../../shared/workspace'
import { DEFAULT_SETTINGS, type Settings } from '../../shared/settings'
import type { LedgerRuntime } from '../ledger/ledgerRuntime'
import type { SessionsLike } from '../orchestrator/workerRuntimeSession'
import { bootCa2, launchLineFor, setActiveCa2 } from './ca2Boot'
import { freshDb } from './guard/controlGuard.testutil'
import { createRegistry } from './tools/toolRegistry'

const withSettings = (over: Partial<Settings>): Settings => ({ ...DEFAULT_SETTINGS, ...over })
const dirs: string[] = []
afterEach(() => { setActiveCa2(null); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

const msgOf = (fn: () => unknown): string => { try { fn() } catch (err) { return (err as Error).message } return 'no throw' }

describe('launchLineFor', () => {
  it('builtin tanpa override = launchCmd builtin apa adanya', () => {
    expect(launchLineFor('claude', DEFAULT_SETTINGS)).toBe(AGENT_CONFIG.claude.launchCmd)
  })

  it('override agentLaunchCommands dipakai untuk builtin', () => {
    expect(launchLineFor('claude', withSettings({ agentLaunchCommands: { claude: 'claude-work' } }))).toBe('claude-work')
  })

  it('custom: launchCmd sendiri; kosong + baseAgent => base (dengan override)', () => {
    const customAgents = [
      { id: 'custom:own', label: 'Own', launchCmd: 'my-proxy --tui' },
      { id: 'custom:base', label: 'Base', launchCmd: '', baseAgent: 'claude' as const },
    ]
    const s = withSettings({ customAgents, agentLaunchCommands: { claude: 'claude-work' } })
    expect(launchLineFor('custom:own', s)).toBe('my-proxy --tui')
    expect(launchLineFor('custom:base', s)).toBe('claude-work')
    expect(launchLineFor('custom:base', withSettings({ customAgents }))).toBe(AGENT_CONFIG.claude.launchCmd)
  })

  it('id asing, custom tanpa perintah, dan nama prototype => agent_kind_unknown', () => {
    const s = withSettings({ customAgents: [{ id: 'custom:empty', label: 'E', launchCmd: '' }] })
    expect(msgOf(() => launchLineFor('nope', s))).toBe('agent_kind_unknown: nope')
    expect(msgOf(() => launchLineFor('custom:empty', s))).toBe('agent_kind_unknown: custom:empty')
    expect(msgOf(() => launchLineFor('toString', s))).toBe('agent_kind_unknown: toString')
  })
})

describe('bootCa2 settings seam', () => {
  it('membaca settings secara lazy (tidak saat boot) sehingga override live berlaku', async () => {
    let reads = 0
    const dir = mkdtempSync(join(tmpdir(), 'ca2-launch-')); dirs.push(dir)
    const handle = bootCa2({
      runtime: { db: freshDb() } as unknown as LedgerRuntime,
      sessions: { open() {}, input() {}, statusOf: () => undefined, getTerminal: () => '', isLive: () => false, close() {} } as unknown as SessionsLike,
      registry: createRegistry(), noTimer: true, dataDirPath: dir, env: { WEBTERM_CENTRAL_AGENTS: 'propose' },
      settings: () => { reads += 1; return DEFAULT_SETTINGS },
    })
    expect(handle?.executor).not.toBeNull()
    await handle?.ready
    expect(reads).toBe(0)
  })
})
