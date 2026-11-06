// F4-c mandatory verifier: judged on real temp git repos (real git + npm scripts, with timeouts),
// plus the pure judge, the timeline/inbox report and the handoff filter.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { allRows } from '../ledger/ledgerCore'
import { gitCommand } from '../gitExec'
import { eventBus } from '../events/eventBus'
import type { SenseEvent } from '../events/eventModel'
import { openFixture } from '../central/centralTestFixture.testutil'
import { evidenceVerified, SERVER_VERIFIED_BY } from '../orchestrator/orchestratorModel'
import type { VerifyOutcome } from '../orchestrator/verify'
import { filterHandoffContext } from './handoff.filter'
import { projectChecks, verifyWorktreeCompletion } from './verifier.checks'
import { judgeCompletion } from './verifier.judge'
import { LEASE_VIOLATION_EVENT, recordCompletion, VERDICT_EVENT } from './verifier.report'
import { isSealedEvidence } from './verifier.seal'

const GIT_TIMEOUT_MS = 20_000
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, timeout: GIT_TIMEOUT_MS, stdio: 'pipe' })

/** Temp repo with one commit; `testExit` is what its `npm test` script exits with. */
function repo(testExit: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'wt-ver-'))
  dirs.push(dir)
  const script = `node -e "console.log('1 passed'); process.exit(${testExit})"`
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', private: true, scripts: { test: script } }))
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1\n')
  git(dir, 'init', '-q')
  git(dir, 'add', '.')
  git(dir, 'commit', '-qm', 'init')
  return dir
}

function outcome(patch: Partial<VerifyOutcome> = {}): VerifyOutcome {
  return {
    verifiedBy: SERVER_VERIFIED_BY, ok: true, reasons: [],
    evidence: [{ command: 'npm test', exitCode: 0, durationMs: 3, outputDigest: 'e'.repeat(64), summary: 'exit 0' }],
    changedFiles: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'], scopeViolations: [],
    tests: { passed: 5, failed: 0, command: 'npm test' }, ...patch,
  }
}

describe('verifyWorktreeCompletion on a real repo', () => {
  it('done without a diff is failed: no changes', async () => {
    const v = await verifyWorktreeCompletion(repo(0), { taskId: 't1', timeoutMs: 60_000 })
    expect(v).toMatchObject({ status: 'failed', reason: 'no_changes', message: 'no changes' })
  }, 90_000)

  it('a red test command is failed even with a diff', async () => {
    const dir = repo(1)
    writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 2\n')
    const v = await verifyWorktreeCompletion(dir, { taskId: 't1', timeoutMs: 60_000 })
    expect(v.status).toBe('failed')
    expect(v.reason).toBe('verify_failed')
    expect(v.message).toContain('npm test exited 1')
  }, 90_000)

  it('green with a diff is done, with sealed evidence and a receipt of what the system ran', async () => {
    const dir = repo(0)
    writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 2\n')
    const v = await verifyWorktreeCompletion(dir, { taskId: 't1', timeoutMs: 60_000, claim: 'I did it all' })
    expect(v).toMatchObject({ status: 'done', reason: 'verified', filesChanged: ['src/a.ts'], summary: '1 file, tests green ✓' })
    expect(isSealedEvidence(v.evidence) && evidenceVerified(v.evidence)).toBe(true)
    expect(v.receipt).toMatchObject({ outcome: 'ok', detail: 'verified', operationId: 't1' })
    const commands = v.receipt.evidence['commands'] as Array<{ command: string; exitCode: number }>
    // The receipt records the argv the system really ran (hardened git flags included), not a short form.
    const ran = (args: string[]) => { const g = gitCommand(args); return [g.file, ...g.args].join(' ') }
    expect(ran(['status', '--porcelain'])).toBe('git -c core.fsmonitor=false -c core.hooksPath=/dev/null status --porcelain')
    expect(commands.map((c) => c.command)).toEqual(expect.arrayContaining([ran(['status', '--porcelain']), ran(['diff', '--name-only']), 'npm test']))
    expect(commands.find((c) => c.command === 'npm test')?.exitCode).toBe(0)
    expect(v.receipt.evidence['workerClaim']).toEqual({ ignored: true, chars: 12 })
    // No `typecheck` script in this project: not run, so not failed for it.
    expect(commands.some((c) => c.command.includes('typecheck'))).toBe(false)
  }, 90_000)

  it('an edit outside the leased paths is a lease_violation', async () => {
    const dir = repo(0)
    writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 2\n')
    writeFileSync(join(dir, 'README.md'), 'outside the lease\n')
    const v = await verifyWorktreeCompletion(dir, { taskId: 't1', lease: ['src'], timeoutMs: 60_000 })
    expect(v).toMatchObject({ status: 'failed', reason: 'lease_violation', leaseViolations: ['README.md'] })
  }, 90_000)
})

describe('judgeCompletion', () => {
  it('green -> done; the worker claim does not change it either way', () => {
    expect(judgeCompletion({ taskId: 't', verdict: outcome(), claim: 'FAILED everything' }).status).toBe('done')
    expect(judgeCompletion({ taskId: 't', verdict: outcome({ changedFiles: [] }), claim: 'done, all green' }).reason).toBe('no_changes')
  })
  it('missing test evidence is verify_failed (no machine evidence)', () => {
    const v = judgeCompletion({ taskId: 't', verdict: outcome({ tests: undefined, evidence: [] }) })
    expect(v).toMatchObject({ status: 'failed', reason: 'verify_failed', message: 'no machine evidence' })
  })
  it('a non-code task may finish without a diff', () => {
    expect(judgeCompletion({ taskId: 't', verdict: outcome({ changedFiles: [] }), codeTask: false }).status).toBe('done')
  })
  it('summary counts files: "4 files, tests green ✓"', () => {
    expect(judgeCompletion({ taskId: 't', verdict: outcome() }).summary).toBe('4 files, tests green ✓')
  })
})

describe('recordCompletion', () => {
  it('appends verdict + lease events and writes an inbox item', () => {
    const f = openFixture()
    const seen: SenseEvent[] = []
    const off = eventBus.subscribe('verifier.*', (e) => seen.push(e))
    try {
      const verdict = judgeCompletion({ taskId: 't9', verdict: outcome({ ok: false, scopeViolations: ['etc/x'] }) })
      recordCompletion({ verdict, taskId: 't9', worker: 'brisk-otter', projectId: 'p1', nodeId: 'n1' }, () => ({ db: f.db, now: () => 1 }))
      const done = judgeCompletion({ taskId: 't10', verdict: outcome() })
      recordCompletion({ verdict: done, taskId: 't10', worker: 'brisk-otter' }, () => ({ db: f.db, now: () => 2 }))
    } finally { off() }
    expect(seen.map((e) => e.kind)).toEqual([VERDICT_EVENT, LEASE_VIOLATION_EVENT, VERDICT_EVENT])
    expect(seen[0]?.payload).toMatchObject({ taskId: 't9', status: 'failed', reason: 'lease_violation' })
    const rows = allRows(f.db, "SELECT kind, title FROM inbox_item WHERE source = 'verifier' ORDER BY created_at")
    expect(rows).toEqual([
      { kind: 'notify', title: 'brisk-otter failed verification: lease violation: etc/x' },
      { kind: 'review', title: 'brisk-otter finished: 4 files, tests green ✓' },
    ])
  })
})

describe('filterHandoffContext', () => {
  const SECRET = 'hunter2-super-secret-value'
  it('masks known secrets (raw and base64) and credential shapes', () => {
    const b64 = Buffer.from(SECRET).toString('base64')
    const out = filterHandoffContext(`pw ${SECRET} enc ${b64} key AKIAABCDEFGHIJKLMNOP`, { knownSecrets: [SECRET] })
    expect(out).not.toContain(SECRET)
    expect(out).not.toContain(b64.slice(0, 20))
    expect(out).not.toContain('AKIAABCDEFGHIJKLMNOP')
  })
  it('keeps only the newest turns, trims each turn, and masks before trimming', () => {
    const turns = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `turn ${i}` }))
    turns.push({ role: 'user', text: `${'x'.repeat(40)}${SECRET}` })
    const out = filterHandoffContext(turns, { knownSecrets: [SECRET], maxTurns: 5, maxTurnChars: 50 })
    expect(out.split('\n')[0]).toBe('[26 earlier turns omitted]')
    expect(out).not.toContain('turn 25')
    expect(out).toContain('turn 26')
    expect(out).not.toContain('hunter2')
  })
  it('caps a plain string', () => {
    expect(filterHandoffContext('a'.repeat(100), { knownSecrets: [], maxChars: 20 })).toHaveLength(20)
  })
})

describe('projectChecks', () => {
  it('follows package.json scripts; no package.json = verifier defaults', () => {
    const dir = repo(0)
    expect(projectChecks(dir)).toEqual({ test: true, typecheck: false, lint: false })
    expect(projectChecks(join(dir, 'src'))).toBeUndefined()
  })
})
