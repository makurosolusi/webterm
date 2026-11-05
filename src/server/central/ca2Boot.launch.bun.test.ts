import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGENT_CONFIG } from '../../shared/workspace'
import { DEFAULT_SETTINGS, type Settings } from '../../shared/settings'
import type { LedgerRuntime } from '../ledger/ledgerRuntime'
import type { SessionsLike } from '../orchestrator/workerRuntimeSession'
import { createAgentCatalog } from './agents/agentCatalog'
import { bootCa2, setActiveCa2 } from './ca2Boot'
import { freshDb } from './guard/controlGuard.testutil'
import { createRegistry } from './tools/toolRegistry'

const withSettings = (over: Partial<Settings>): Settings => ({ ...DEFAULT_SETTINGS, ...over })
const dirs: string[] = []
afterEach(() => { setActiveCa2(null); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

const lineOf = (kind: string, s: Settings): string | null => createAgentCatalog({ settings: () => s }).resolve(kind)?.launchLine ?? null

describe('catalog launch line (was launchLineFor)', () => {
  it('builtin tanpa override = launchCmd builtin apa adanya', () => {
    expect(lineOf('claude', DEFAULT_SETTINGS)).toBe(AGENT_CONFIG.claude.launchCmd)
  })

  it('claude memakai profil default; override agentLaunchCommands dipakai untuk builtin lain', () => {
    expect(lineOf('claude', withSettings({ claudeLaunchProfiles: [{ id: 'w', name: 'W', command: 'claude-work' }], defaultClaudeProfileId: 'w' }))).toBe('claude-work')
    expect(lineOf('codex', withSettings({ agentLaunchCommands: { codex: 'codex-work' } }))).toBe('codex-work')
  })

  it('custom (centralSpawn): launchCmd sendiri; kosong + baseAgent => base (dengan override)', () => {
    const customAgents = [
      { id: 'custom:own', label: 'Own', launchCmd: 'my-proxy --tui', centralSpawn: true },
      { id: 'custom:base', label: 'Base', launchCmd: '', baseAgent: 'claude' as const, centralSpawn: true },
    ]
    const s = withSettings({ customAgents, claudeLaunchProfiles: [{ id: 'w', name: 'W', command: 'claude-work' }], defaultClaudeProfileId: 'w' })
    expect(lineOf('custom:own', s)).toBe('my-proxy --tui')
    expect(lineOf('custom:base', s)).toBe('claude-work')
    expect(lineOf('custom:base', withSettings({ customAgents }))).toBe(AGENT_CONFIG.claude.launchCmd)
  })

  it('id asing, custom tanpa perintah, custom tertutup, dan nama prototype => null (agent_kind_unknown)', () => {
    const s = withSettings({ customAgents: [
      { id: 'custom:empty', label: 'E', launchCmd: '', centralSpawn: true },
      { id: 'custom:closed', label: 'C', launchCmd: 'x' },
    ] })
    for (const k of ['nope', 'custom:empty', 'custom:closed', 'toString']) expect(lineOf(k, s)).toBeNull()
  })
})

describe('bootCa2 settings seam', () => {
  it('membaca settings secara lazy (tidak saat boot) sehingga override live berlaku', async () => {
    let reads = 0
    const dir = mkdtempSync(join(tmpdir(), 'ca2-launch-')); dirs.push(dir)
    const handle = bootCa2({
      runtime: { db: freshDb() } as unknown as LedgerRuntime,
      sessions: { open() {}, input() {}, statusOf: () => undefined, getTerminal: () => '', isLive: () => false, close() {} } as unknown as SessionsLike,
      registry: createRegistry(), noTimer: true, dataDirPath: dir, env: { WEBTERM_CENTRAL: 'on', WEBTERM_CENTRAL_AGENTS: 'propose' },
      settings: () => { reads += 1; return DEFAULT_SETTINGS },
    })
    expect(handle?.executor).not.toBeNull()
    await handle?.ready
    expect(reads).toBe(0)
  })
})
