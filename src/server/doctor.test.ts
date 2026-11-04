// Doctor v1: pass and fail path of every check with fake dependencies, and the fix contract.
import { describe, expect, it } from 'vitest'
import { fixDoctor, runDoctor, type DoctorCheck, type DoctorDeps, type DoctorId } from './doctor'
import type { ProviderView } from './claudeProvider/claudeProvider.model'

function deps(over: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    onPath: () => true, claudeReady: async () => ({ ok: true }), opencodeBin: 'opencode', opencodeReady: async () => ({ ok: true }),
    generated: () => [{ label: 'context-link skill', path: '/s', expected: 'v2' }], readFile: () => 'v2', installGenerated: () => {},
    telegram: async () => ({ state: 'ok', name: '@bot' }), sandbox: () => ({ on: true, supported: true }), setSandbox: () => {},
    looseDirs: () => [], tightenDirs: () => {}, verifyLedger: () => ({ ok: true, checked: 4, head: null }), ...over,
  }
}
const byId = async (d: DoctorDeps): Promise<Record<DoctorId, DoctorCheck>> =>
  Object.fromEntries((await runDoctor(d)).map((c) => [c.id, c])) as Record<DoctorId, DoctorCheck>

describe('runDoctor', () => {
  it('all green on a healthy machine, no fix offered', async () => {
    const all = await runDoctor(deps())
    expect(all.map((c) => c.status)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok'])
    expect(all.some((c) => c.fix)).toBe(false)
  })

  it('reports each failure with an explanation and a fix only where it is safe', async () => {
    const c = await byId(deps({
      onPath: (b) => b === 'claude' || b === 'opencode', // rg + tmux missing
      claudeReady: async () => ({ ok: false, reason: 'not logged in' }),
      opencodeReady: async () => ({ ok: false, reason: 'no model configured' }),
      readFile: () => 'v1',
      telegram: async () => ({ state: 'rejected' }),
      sandbox: () => ({ on: false, supported: true }),
      looseDirs: () => ['/data'],
      verifyLedger: () => ({ ok: false, checked: 2, head: null, brokenAt: { seq: 7, reason: 'hash_mismatch' } }),
    }))
    expect(c.claude).toMatchObject({ status: 'fail' })
    expect(c.claude.detail).toContain('not logged in')
    expect(c.claude.fix).toBeUndefined() // login is interactive
    expect(c.opencode).toMatchObject({ status: 'warn' })
    expect(c.skills).toMatchObject({ status: 'fail', fix: 'Reinstall' })
    expect(c.skills.detail).toContain('context-link skill')
    expect(c.telegram).toMatchObject({ status: 'fail' })
    expect(c.ripgrep.status).toBe('warn')
    expect(c.tmux.status).toBe('warn')
    expect(c.sandbox).toMatchObject({ status: 'warn', fix: 'Turn on' })
    expect(c.dataDir).toMatchObject({ status: 'fail', fix: 'Restrict to 0700' })
    expect(c.ledger.status).toBe('fail')
    expect(c.ledger.detail).toContain('event 7')
    expect(c.ledger.fix).toBeUndefined()
  })

  it('off states: CLI missing, no bot, unsupported sandbox, ledger off, network down', async () => {
    const c = await byId(deps({
      onPath: () => false, telegram: async () => ({ state: 'unset' }), sandbox: () => ({ on: false, supported: false }), verifyLedger: () => null,
    }))
    expect([c.claude.status, c.opencode.status, c.telegram.status, c.sandbox.status, c.ledger.status]).toEqual(['warn', 'off', 'off', 'off', 'off'])
    expect((await byId(deps({ telegram: async () => ({ state: 'unreachable' }) }))).telegram.status).toBe('warn')
  })

  it('a shell-locked sandbox explains the lock and offers no fix', async () => {
    const c = await byId(deps({ sandbox: () => ({ on: false, supported: true, lockReason: 'Set in the shell environment.' }) }))
    expect(c.sandbox.fix).toBeUndefined()
    expect(c.sandbox.detail).toContain('shell environment')
  })

  it('a throwing probe becomes a fail row; the other checks still run', async () => {
    const all = await runDoctor(deps({ verifyLedger: () => { throw new Error('disk I/O error') } }))
    expect(all.find((c) => c.id === 'ledger')).toMatchObject({ status: 'fail' })
    expect(all.find((c) => c.id === 'ledger')?.detail).toContain('disk I/O error')
    expect(all.filter((c) => c.status === 'ok')).toHaveLength(8)
  })
})

describe('fixDoctor', () => {
  it('runs the fix and returns the re-run check', async () => {
    let on = false
    const out = await fixDoctor('sandbox', deps({ sandbox: () => ({ on, supported: true }), setSandbox: (v) => { on = v } }))
    expect(out).toMatchObject({ ok: true, check: { id: 'sandbox', status: 'ok' } })
    let installed = false
    const skills = await fixDoctor('skills', deps({ readFile: () => (installed ? 'v2' : null), installGenerated: () => { installed = true } }))
    expect(skills).toMatchObject({ ok: true, check: { status: 'ok' } })
  })

  it('refuses when the check offers no fix (healthy, or not safely fixable)', async () => {
    expect(await fixDoctor('dataDir', deps())).toEqual({ ok: false, error: 'no_fix' })
    expect(await fixDoctor('claude', deps({ claudeReady: async () => ({ ok: false, reason: 'x' }) }))).toEqual({ ok: false, error: 'no_fix' })
  })
})

describe('Claude provider in the claude check', () => {
  const prov = (view: Partial<ProviderView> & Pick<ProviderView, 'mode'>, lastTest: { ok: boolean; message: string } | null = null) =>
    deps({ claudeReady: async () => ({ ok: false, reason: 'not logged in' }), claudeProvider: () => ({ view: { secretSet: false, ready: false, ...view }, lastTest }) })
  it('login mode (also when the dependency is absent) still checks the Claude Code login', async () => {
    expect((await byId(deps())).claude).toMatchObject({ status: 'ok', detail: 'Installed and logged in.' })
    expect((await byId(prov({ mode: 'login', ready: true }))).claude).toMatchObject({ status: 'fail' })
  })
  it('a key provider replaces the login check: no key fails, untested warns, the last test decides', async () => {
    expect((await byId(prov({ mode: 'apiKey' }))).claude).toMatchObject({ status: 'fail' })
    const custom = { mode: 'custom' as const, baseUrl: 'https://gw.example.test/x', secretSet: true, ready: true }
    const untested = (await byId(prov(custom))).claude
    expect(untested).toMatchObject({ status: 'warn' })
    expect(untested.detail).toContain('gw.example.test')
    expect(await byId(prov(custom, { ok: false, message: 'The endpoint rejected the credential.' }))).toMatchObject({ claude: { status: 'fail' } })
    expect(await byId(prov(custom, { ok: true, message: 'Connected.' }))).toMatchObject({ claude: { status: 'ok' } })
  })
})
