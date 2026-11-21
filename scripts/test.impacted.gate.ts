// Guards for `npm run test:impacted` on a weak shared machine: one gate at a time (machine-wide lock),
// a width limit that refuses plans close to a full suite, and a time estimate printed before running.
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildReverseGraph, dependentsOf } from './test.impacted.graph'
import { isTest, type Plan } from './test.impacted.plan'
import type { Step } from './test.impacted.run'

/** Exit codes: wide plan refused / another gate holds the lock / budget exceeded. */
export const EXIT_WIDE = 2
export const EXIT_BUSY = 3
export const EXIT_BUDGET = 4

/** Env var that lets the owner/orchestrator run a wide gate. Agents must never set it (same spirit as WEBTERM_FULL_TESTS). */
export const WIDE_GATE_ENV = 'WEBTERM_ALLOW_WIDE_GATE'
/** Env var overriding the lock directory (tests). */
export const LOCK_DIR_ENV = 'WEBTERM_TEST_GATE_LOCK_DIR'
const LOCK_NAME = 'webterm-test-gate.lock'

/** Measured 2026-11-21 with --dry: a changed test or scripts/ edit plans ~75 files, App.tsx ~85+; a hub like envRegistry plans 280+ (bun 204-213 of 375). */
export const MAX_GATE_FILES = 120
/** Also refuse when the plan covers more than this share of all test files (matters only in a small repo). */
export const MAX_GATE_SHARE = 0.4
/** A lock older than this is stale even if its pid lives (pid reuse, hung gate). */
export const LOCK_STALE_MS = 2 * 60 * 60 * 1000
/** Seconds per batch of 40 files, measured on the 8-core/8 GB dev machine (bun); vitest and typecheck are rough guesses. */
export const EST_SECONDS = { bun: 25, vitest: 40, typecheck: 60 } as const

export class GateError extends Error {
  constructor(message: string, readonly exitCode: number) { super(message) }
}

type Holder = { pid: number; cwd: string; startedAt: number; command: string }
export type LockOpts = {
  dir?: string; pid?: number; cwd?: string; command?: string
  now?: () => number; isAlive?: (pid: number) => boolean
  /** Minutes to queue behind another gate; 0 fails fast. */
  waitMinutes?: number; pollMs?: number
}

/** Lock files live in a fixed dir, not os.tmpdir(): callers set different TMPDIRs and would never see each other. */
const lockDir = (dir?: string): string => dir ?? process.env[LOCK_DIR_ENV] ?? (process.platform === 'win32' ? tmpdir() : '/tmp')
const defaultAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' } }
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function readHolder(path: string): Holder | null {
  try { return JSON.parse(readFileSync(path, 'utf8')) as Holder } catch { return null }
}

/** Takes the machine-wide gate lock; returns a release function. Throws GateError(EXIT_BUSY) when held and not waited out. */
export async function acquireGate(o: LockOpts = {}): Promise<() => void> {
  const dir = lockDir(o.dir)
  const path = join(dir, LOCK_NAME)
  const now = o.now ?? Date.now
  const alive = o.isAlive ?? defaultAlive
  const pid = o.pid ?? process.pid
  const mine: Holder = { pid, cwd: o.cwd ?? process.cwd(), startedAt: now(), command: o.command ?? process.argv.slice(1).join(' ') }
  const deadline = now() + (o.waitMinutes ?? 0) * 60_000
  mkdirSync(dir, { recursive: true })
  for (;;) {
    try {
      writeFileSync(path, JSON.stringify(mine), { flag: 'wx' }) // atomic create-if-absent
      break
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error(`gate lock ${path}: ${(e as Error).message}`)
    }
    const h = readHolder(path)
    // Unreadable file = a writer mid-create or garbage; only treat as stale when it parses and is dead/old.
    if (h && (!alive(h.pid) || now() - h.startedAt > LOCK_STALE_MS)) {
      try { unlinkSync(path) } catch { /* another process took it over first; loop retries wx */ }
      continue
    }
    if (now() >= deadline) {
      const mins = h ? Math.round((now() - h.startedAt) / 60_000) : '?'
      throw new GateError(`gate lain sedang berjalan; tunggu atau jalankan nanti (--wait <menit> untuk antri).\n  pemegang: pid ${h?.pid ?? '?'}, ${h?.cwd ?? '?'}, ${mins} menit\n  perintah: ${h?.command ?? '?'}`, EXIT_BUSY)
    }
    await sleep(o.pollMs ?? 2000)
  }
  let released = false
  return () => {
    if (released) return
    released = true
    if (readHolder(path)?.pid === pid) { try { unlinkSync(path) } catch { /* already gone */ } }
  }
}

/** Release the lock on every exit path: normal exit, SIGINT, SIGTERM. */
export function releaseOnExit(release: () => void): void {
  process.on('exit', release)
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { release(); process.exit(128 + (sig === 'SIGINT' ? 2 : 15)) })
}

export const planFileCount = (plan: Plan): number =>
  new Set([...plan.vitestTests, ...plan.vitestGraph, ...plan.bun, ...plan.bunReal, ...plan.policy.vitest, ...plan.policy.bun]).size

/** Seconds estimate: batches (one per step) x per-batch constant. Steps already hold the 40-file chunks. */
export const estimateSeconds = (steps: Step[]): number =>
  steps.reduce((n, s) => n + (s.section === 'typecheck' ? EST_SECONDS.typecheck : /vitest/.test(s.label) ? EST_SECONDS.vitest : EST_SECONDS.bun), 0)

export function describeEstimate(plan: Plan, steps: Step[]): string {
  const count = (sec: Step['section']): number => steps.filter((s) => s.section === sec).reduce((n, s) => n + s.files.length, 0)
  return `gate: ${planFileCount(plan)} file(s) (vitest+bun+policy), ${steps.length} command(s), estimated ~${Math.ceil(estimateSeconds(steps) / 60)} min `
    + `(vitest ${count('vitest')}, bun ${count('bun')}, policy ${count('policy')}; ${EST_SECONDS.bun}s/bun batch, ${EST_SECONDS.vitest}s/vitest batch)`
}

/** Changed files ranked by how many test files they pull in (the hubs that widen a plan). */
export function topHubs(changed: string[], fs: { files: string[]; read: (f: string) => string }, n = 5): { file: string; tests: number }[] {
  const reverse = buildReverseGraph(fs.files, fs.read)
  return changed.map((file) => ({ file, tests: [...dependentsOf([file], reverse)].filter(isTest).length }))
    .sort((a, b) => b.tests - a.tests).slice(0, n)
}

/** Throws GateError(EXIT_WIDE) when the plan is close to a full suite and the owner override is absent. */
export function checkWidth(plan: Plan, totalTests: number, hubs: () => { file: string; tests: number }[], env: Record<string, string | undefined> = process.env): void {
  const n = planFileCount(plan)
  if ((n <= MAX_GATE_FILES && n <= totalTests * MAX_GATE_SHARE) || env[WIDE_GATE_ENV] === '1') return
  const lines = hubs().map((h) => `    ${h.file}  -> ${h.tests} test file(s)`).join('\n')
  throw new GateError(
    `plan terlalu lebar: ${n} berkas (batas ${MAX_GATE_FILES} atau ${MAX_GATE_SHARE * 100}% dari ${totalTests} berkas tes) -- mendekati suite penuh, ditolak.\n`
    + `  berkas berubah yang paling melebarkan plan:\n${lines}\n`
    + `  saran: pecah pekerjaan, lalu jalankan tes terfokus: npm run test:impacted -- --files <tes-terkait> ...\n`
    + `  gate lebar hanya untuk pemilik/orkestrator (${WIDE_GATE_ENV}=1); agent dilarang menyetelnya.`, EXIT_WIDE)
}

/** Remaining-budget check between batches: returns the unrun steps' labels when the budget is spent, else null. */
export function budgetExceeded(steps: Step[], nextIndex: number, startedAt: number, budgetMinutes: number | null, now = Date.now()): string[] | null {
  if (budgetMinutes === null || nextIndex >= steps.length || now - startedAt < budgetMinutes * 60_000) return null
  return steps.slice(nextIndex).map((s) => `${s.section}: ${s.label}`)
}
