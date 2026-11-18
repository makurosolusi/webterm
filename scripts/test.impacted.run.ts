// Step builder and runner for `test:impacted`: turns a Plan into commands, runs them one at a time
// (the dev machine is weak: no parallel suites) and reports per-section results.
import { spawn } from 'node:child_process'
import { closeSync, mkdtempSync, openSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Plan } from './test.impacted.plan'

/** Files per command: stays under the guards' filter limit (scripts/testGuard.decide.ts). */
const CHUNK = 40

export type Section = 'typecheck' | 'vitest' | 'bun' | 'policy'
export type Step = { section: Section; label: string; cmd: string; args: string[]; env?: Record<string, string>; files: string[] }
export type StepResult = { step: Step; ok: boolean; seconds: number; log: string; failed: string[] }

const chunks = <T>(xs: T[]): T[][] => Array.from({ length: Math.ceil(xs.length / CHUNK) }, (_, i) => xs.slice(i * CHUNK, (i + 1) * CHUNK))

/** `nice -n 15` in front of a command when the platform has nice. */
export function lowPriority(cmd: string, args: string[], hasNice: boolean): { cmd: string; args: string[] } {
  return hasNice ? { cmd: 'nice', args: ['-n', '15', cmd, ...args] } : { cmd, args }
}

export function buildSteps(plan: Plan, root: string, opts: { typecheck: boolean; bunPath: string }): Step[] {
  const vitest = join(root, 'node_modules/.bin/vitest')
  const workers = '--maxWorkers=2'
  const steps: Step[] = []
  if (opts.typecheck) steps.push({ section: 'typecheck', label: 'typecheck', cmd: 'npm', args: ['run', 'typecheck'], files: [] })
  const addVitest = (section: Section, mode: 'run' | 'related', files: string[]): void => {
    for (const part of chunks(files)) {
      const args = mode === 'run' ? ['run', workers, ...part] : ['related', '--run', workers, ...part]
      steps.push({ section, label: `vitest ${mode} (${part.length})`, cmd: vitest, args, files: part })
    }
  }
  const addBun = (section: Section, label: string, files: string[], realHome: boolean): void => {
    for (const part of chunks(files)) {
      steps.push({ section, label: `${label} (${part.length})`, cmd: opts.bunPath, args: ['test', '--no-env-file', ...part], env: realHome ? {} : { HOME: '@tmp-home' }, files: part })
    }
  }
  addVitest('vitest', 'run', plan.vitestTests)
  addVitest('vitest', 'related', plan.vitestRelated)
  addBun('bun', 'bun test', plan.bun, false)
  // Real-Chromium suites need the real HOME (see src/testIsolation.setup.ts).
  addBun('bun', 'bun test real', plan.bunReal, true)
  addVitest('policy', 'run', plan.policy.vitest)
  addBun('policy', 'bun test policy', plan.policy.bun, false)
  return steps
}

/** Failing test files named in a vitest or bun log (` FAIL  path > test` / `path:` header before `(fail)`). */
export function failedFiles(log: string): string[] {
  const out = new Set<string>()
  let header = ''
  for (const line of log.split('\n')) {
    const v = /^\s*FAIL\s+(\S+\.test\.tsx?)/.exec(line)
    if (v) out.add(v[1]!)
    const h = /^(\S+\.test\.tsx?):$/.exec(line)
    if (h) header = h[1]!
    if (line.startsWith('(fail)') && header) out.add(header)
  }
  return [...out].sort()
}

/** The command a person can paste to rerun one failing file on its own. */
export const rerunCommand = (file: string): string =>
  /\.bun\.test\.ts$/.test(file) ? `HOME=$(mktemp -d) bun test --no-env-file ${file}` : `npx vitest run ${file}`

export function runStep(step: Step, cwd: string, hasNice: boolean): Promise<StepResult> {
  const dir = mkdtempSync(join(tmpdir(), 'webterm-impacted-'))
  const logPath = join(dir, 'out.log')
  const env: Record<string, string | undefined> = { ...process.env, ...step.env }
  if (step.env?.HOME === '@tmp-home') env.HOME = mkdtempSync(join(dir, 'home-'))
  const { cmd, args } = lowPriority(step.cmd, step.args, hasNice)
  const fd = openSync(logPath, 'w')
  const start = Date.now()
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', fd, fd] })
    let spawnError = ''
    const done = (ok: boolean): void => {
      closeSync(fd)
      const log = readFileSync(logPath, 'utf8') + spawnError
      resolve({ step, ok, seconds: (Date.now() - start) / 1000, log, failed: ok ? [] : failedFiles(log) })
    }
    child.on('error', (e) => { spawnError = `could not start ${cmd}: ${e.message}\n`; done(false) })
    child.on('close', (code) => done(code === 0))
  })
}
