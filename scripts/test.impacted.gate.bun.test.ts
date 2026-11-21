import { afterEach, describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  EXIT_BUDGET, EXIT_BUSY, EXIT_WIDE, GateError, LOCK_STALE_MS, MAX_GATE_FILES, WIDE_GATE_ENV,
  acquireGate, budgetExceeded, checkWidth, describeEstimate, estimateSeconds, planFileCount, topHubs,
} from './test.impacted.gate'
import type { Plan } from './test.impacted.plan'
import type { Step } from './test.impacted.run'

const dirs: string[] = []
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), 'gate-test-')); dirs.push(d); return d }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
const LOCK = (d: string): string => join(d, 'webterm-test-gate.lock')

const planOf = (bun: number): Plan => ({
  vitestTests: [], vitestGraph: [], vitestRelated: [], bun: Array.from({ length: bun }, (_, i) => `src/server/f${i}.bun.test.ts`), bunReal: [],
  policy: { vitest: [], bun: [], reasons: [] },
})
const step = (section: Step['section'], label: string, n = 40): Step => ({ section, label, cmd: 'x', args: [], files: Array(n).fill('f') })

describe('gate lock', () => {
  test('acquire writes holder, release removes it', async () => {
    const dir = tmp()
    const release = await acquireGate({ dir, pid: 111, cwd: '/wt/a', command: 'gate' })
    expect(JSON.parse(readFileSync(LOCK(dir), 'utf8'))).toMatchObject({ pid: 111, cwd: '/wt/a', command: 'gate' })
    release(); release()
    expect(existsSync(LOCK(dir))).toBe(false)
  })

  test('busy fails fast with exit 3 and names the holder', async () => {
    const dir = tmp()
    let t = 10 * 60_000
    await acquireGate({ dir, pid: 1, cwd: '/wt/holder', now: () => t, isAlive: () => true })
    t += 7 * 60_000
    const err = await acquireGate({ dir, pid: 2, now: () => t, isAlive: () => true }).catch((e) => e as GateError)
    expect(err instanceof GateError).toBe(true)
    expect((err as GateError).exitCode).toBe(EXIT_BUSY)
    expect((err as GateError).message).toMatch(/gate lain sedang berjalan; tunggu atau jalankan nanti/)
    expect((err as GateError).message).toMatch(/pid 1, \/wt\/holder, 7 menit/)
  })

  test('stale: dead pid is taken over', async () => {
    const dir = tmp()
    await acquireGate({ dir, pid: 1, isAlive: () => true })
    const release = await acquireGate({ dir, pid: 2, isAlive: (p) => p !== 1 })
    expect(JSON.parse(readFileSync(LOCK(dir), 'utf8')).pid).toBe(2)
    release()
  })

  test('stale: older than 2h is taken over even if pid lives', async () => {
    const dir = tmp()
    let t = 0
    await acquireGate({ dir, pid: 1, now: () => t, isAlive: () => true })
    t = LOCK_STALE_MS + 1
    await acquireGate({ dir, pid: 2, now: () => t, isAlive: () => true })
    expect(JSON.parse(readFileSync(LOCK(dir), 'utf8')).pid).toBe(2)
  })

  test('release does not remove a lock someone else took over', async () => {
    const dir = tmp()
    const release = await acquireGate({ dir, pid: 1 })
    writeFileSync(LOCK(dir), JSON.stringify({ pid: 2, cwd: '', startedAt: Date.now(), command: '' }))
    release()
    expect(existsSync(LOCK(dir))).toBe(true)
  })

  test('--wait queues until the holder releases', async () => {
    const dir = tmp()
    const first = await acquireGate({ dir, pid: process.pid })
    setTimeout(first, 60)
    const second = await acquireGate({ dir, pid: process.pid + 1, isAlive: () => true, waitMinutes: 1, pollMs: 10 })
    expect(JSON.parse(readFileSync(LOCK(dir), 'utf8')).pid).toBe(process.pid + 1)
    second()
  })

  test('two real child processes: exactly one gets the lock, the other exits 3', async () => {
    const dir = tmp()
    const script = join(import.meta.dirname, 'test.impacted.gate.ts')
    const code = `import { acquireGate } from ${JSON.stringify(script)}
try { const r = await acquireGate({ dir: ${JSON.stringify(dir)} }); await new Promise((s) => setTimeout(s, 1500)); r() } catch (e) { process.exit(e.exitCode ?? 1) }`
    const run = (): Promise<number> => new Promise((res) => spawn(process.execPath, ['-e', code], { stdio: 'ignore' }).on('close', (c) => res(c ?? -1)))
    const codes = (await Promise.all([run(), run()])).sort()
    expect(codes).toEqual([0, EXIT_BUSY])
    expect(existsSync(LOCK(dir))).toBe(false)
  })
})

const throws = (f: () => void): boolean => { try { f(); return false } catch { return true } }

describe('width guard', () => {
  const hubs = (): { file: string; tests: number }[] => [{ file: 'src/server/envRegistry.ts', tests: 512 }]
  test('plan at the threshold passes, above it is refused with exit 2', () => {
    expect(throws(() => checkWidth(planOf(MAX_GATE_FILES), 1500, hubs, {}))).toBe(false)
    const err = (() => { try { checkWidth(planOf(MAX_GATE_FILES + 1), 1500, hubs, {}) } catch (e) { return e as GateError } })()!
    expect(err.exitCode).toBe(EXIT_WIDE)
    expect(err.message).toMatch(/envRegistry\.ts {2}-> 512/)
    expect(err.message).toMatch(/--files <tes-terkait>/)
    expect(err.message).toMatch(/WEBTERM_ALLOW_WIDE_GATE=1/)
  })
  test('share rule: more than 40% of a small repo is wide', () => {
    expect(throws(() => checkWidth(planOf(50), 100, hubs, {}))).toBe(true)
    expect(throws(() => checkWidth(planOf(40), 100, hubs, {}))).toBe(false)
  })
  test('owner env override allows a wide plan; any other value does not', () => {
    expect(throws(() => checkWidth(planOf(300), 1500, hubs, { [WIDE_GATE_ENV]: '1' }))).toBe(false)
    expect(throws(() => checkWidth(planOf(300), 1500, hubs, { [WIDE_GATE_ENV]: 'true' }))).toBe(true)
  })
  test('topHubs ranks changed files by dependent test files', () => {
    const src: Record<string, string> = {
      'src/a.ts': '', 'src/b.ts': '', 'src/t1.test.ts': "import './a'", 'src/t2.test.ts': "import './a'", 'src/t3.test.ts': "import './b'",
    }
    const r = topHubs(['src/b.ts', 'src/a.ts'], { files: Object.keys(src), read: (f) => src[f] ?? '' })
    expect(r).toEqual([{ file: 'src/a.ts', tests: 2 }, { file: 'src/b.ts', tests: 1 }])
  })
  test('planFileCount counts files and the estimate uses per-batch constants', () => {
    expect(planFileCount(planOf(3))).toBe(3)
    const steps = [step('bun', 'bun test (40)'), step('vitest', 'vitest run (40)')]
    expect(estimateSeconds(steps)).toBe(65)
    expect(describeEstimate(planOf(40), steps)).toMatch(/estimated ~2 min/)
  })
})

describe('budget', () => {
  const steps = [step('bun', 'a'), step('bun', 'b'), step('policy', 'c')]
  test('null budget or time left: keep going', () => {
    expect(budgetExceeded(steps, 1, 0, null, 99 * 60_000)).toBeNull()
    expect(budgetExceeded(steps, 1, 0, 5, 4 * 60_000)).toBeNull()
  })
  test('spent budget lists the unrun batches', () => {
    expect(budgetExceeded(steps, 1, 0, 5, 5 * 60_000)).toEqual(['bun: b', 'policy: c'])
    expect(EXIT_BUDGET).toBe(4)
  })
  test('nothing left to run is not a budget failure', () => {
    expect(budgetExceeded(steps, 3, 0, 1, 10 * 60_000)).toBeNull()
  })
})
