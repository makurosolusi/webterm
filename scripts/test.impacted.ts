// `npm run test:impacted`: the daily test tier. Runs only what a change can break:
//   1. vitest files related to the changed sources (+ changed tests),
//   2. bun tests that transitively import a changed file (static import graph),
//   3. the policy tier: scanner tests (scripts/test.policy.manifest.ts) whose domain the change touches.
// Never runs a full suite, and only one gate runs per machine. Options: --dry --no-policy --typecheck --base <ref>
// --files <a> <b> ... --wait <min> (queue behind another gate) --budget <min> (stop between batches when spent)
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { cpus, loadavg } from 'node:os'
import { join } from 'node:path'
import { buildPlan, isTest, type Plan } from './test.impacted.plan'
import { EXIT_BUDGET, GateError, acquireGate, budgetExceeded, checkWidth, describeEstimate, releaseOnExit, topHubs } from './test.impacted.gate'
import { buildSteps, rerunCommand, runStep, type Section, type StepResult } from './test.impacted.run'

const ROOT = join(import.meta.dirname, '..')
const SOURCE_TREES = ['src', 'scripts']
/** unix socket paths blow past 104 chars under macOS's default TMPDIR (see CLAUDE.md). */
const SHORT_TMPDIR = '/tmp/st'

export type Options = { dry: boolean; policy: boolean; typecheck: boolean; base: string | null; files: string[] | null; wait: number; budget: number | null }

const minutes = (flag: string, v: string | undefined): number => {
  const n = Number(v)
  if (!v || !Number.isFinite(n) || n < 0) throw new Error(`${flag} needs a number of minutes`)
  return n
}

export function parseOptions(argv: string[]): Options {
  const o: Options = { dry: false, policy: true, typecheck: false, base: null, files: null, wait: 0, budget: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--dry') o.dry = true
    else if (a === '--no-policy') o.policy = false
    else if (a === '--typecheck') o.typecheck = true
    else if (a === '--base') o.base = argv[++i] ?? null
    else if (a === '--wait') o.wait = minutes(a, argv[++i])
    else if (a === '--budget') o.budget = minutes(a, argv[++i])
    else if (a === '--files') { o.files = []; while (argv[i + 1] && !argv[i + 1]!.startsWith('--')) o.files.push(argv[++i]!) }
    else throw new Error(`unknown option ${a} (use --dry --no-policy --typecheck --base <ref> --files <paths...> --wait <min> --budget <min>)`)
  }
  if (o.base === null && argv.includes('--base')) throw new Error('--base needs a ref')
  return o
}

const git = (args: string[]): string => {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr.trim()}`)
  return r.stdout
}
const lines = (s: string): string[] => s.split('\n').map((l) => l.trim()).filter(Boolean)

/** Committed-on-branch + uncommitted + untracked changes, repo-relative. */
export function changedFiles(base: string | null): string[] {
  const refs = base ? [base] : ['main', 'origin/main']
  let mergeBase = ''
  for (const ref of refs) {
    const r = spawnSync('git', ['merge-base', 'HEAD', ref], { cwd: ROOT, encoding: 'utf8' })
    if (r.status === 0) { mergeBase = r.stdout.trim(); break }
  }
  if (!mergeBase) throw new Error(`no merge-base with ${refs.join(' or ')}: pass --base <ref> or --files <paths...>`)
  return [...new Set([
    ...lines(git(['diff', '--name-only', `${mergeBase}...HEAD`])),
    ...lines(git(['diff', '--name-only', 'HEAD'])),
    ...lines(git(['ls-files', '--others', '--exclude-standard'])),
  ])].sort()
}

const repoFiles = (): string[] =>
  SOURCE_TREES.flatMap((d) => (readdirSync(join(ROOT, d), { recursive: true }) as string[]).map((f) => `${d}/${f.split('\\').join('/')}`))

export function printPlan(changed: string[], plan: Plan, policyOn: boolean): void {
  const { policy } = plan
  console.log(`changed files: ${changed.length}`)
  console.log(`vitest: ${plan.vitestTests.length} changed test file(s) + related to ${plan.vitestRelated.length} changed source file(s)`)
  console.log(`        added by import graph: ${plan.vitestGraph.length}`)
  console.log(`bun:    ${plan.bun.length} impacted file(s)${plan.bunReal.length ? ` + ${plan.bunReal.length} real-browser file(s) (changed themselves)` : ''}`)
  if (!policyOn) console.log('policy: skipped (--no-policy)')
  else if (!policy.reasons.length) console.log('policy: nothing triggered by these changes')
  else {
    console.log(`policy: ${policy.vitest.length} vitest + ${policy.bun.length} bun scanner file(s), triggered by`)
    for (const r of policy.reasons) console.log(`        ${r}`)
  }
}

function warnIfBusy(): void {
  const load = loadavg()[0]!
  if (load > cpus().length) console.warn(`warning: load average ${load.toFixed(1)} is above ${cpus().length} cores; timeouts may be false. Consider waiting for the machine to settle (continuing anyway).`)
}

function summarize(results: StepResult[], seconds: number): boolean {
  const bySection = new Map<Section, StepResult[]>()
  for (const r of results) bySection.set(r.step.section, [...(bySection.get(r.step.section) ?? []), r])
  console.log('\nsummary')
  for (const [section, rs] of bySection) {
    const fail = rs.filter((r) => !r.ok).length
    const secs = rs.reduce((n, r) => n + r.seconds, 0)
    console.log(`  ${section.padEnd(9)} ${fail ? 'FAIL' : 'ok  '} ${rs.length - fail}/${rs.length} command(s)  ${secs.toFixed(1)}s`)
  }
  console.log(`  total     ${(seconds / 60).toFixed(1)} min`)
  const bad = results.filter((r) => !r.ok)
  for (const r of bad) {
    console.log(`\nFAILED ${r.step.section}: ${r.step.label}`)
    console.log(r.log.split('\n').slice(-30).join('\n'))
    for (const f of r.failed) console.log(`  rerun alone: ${rerunCommand(f)}`)
  }
  return bad.length === 0
}

async function main(): Promise<number> {
  const opts = parseOptions(process.argv.slice(2))
  const tmp = process.env.TMPDIR
  if (!tmp || tmp.length > 40) { process.env.TMPDIR = SHORT_TMPDIR; mkdirSync(SHORT_TMPDIR, { recursive: true }) }
  const changed = opts.files ?? changedFiles(opts.base)
  const plan = buildPlan(changed, { files: repoFiles(), read: (f) => readFileSync(join(ROOT, f), 'utf8'), exists: (f) => existsSync(join(ROOT, f)) }, { policy: opts.policy })
  const fs = { files: repoFiles(), read: (f: string) => readFileSync(join(ROOT, f), 'utf8') }
  printPlan(changed, plan, opts.policy)
  const steps = buildSteps(plan, ROOT, { typecheck: opts.typecheck, bunPath: process.execPath })
  console.log(describeEstimate(plan, steps))
  try { checkWidth(plan, fs.files.filter(isTest).length, () => topHubs(changed.filter((f) => existsSync(join(ROOT, f))), fs)) } catch (e) {
    if (!opts.dry) throw e
    console.log(`\n(--dry: a real run would be refused)\n${(e as Error).message}`)
  }
  if (opts.dry) return 0
  if (!steps.length) { console.log('\nnothing to run.'); return 0 }
  releaseOnExit(await acquireGate({ waitMinutes: opts.wait, cwd: ROOT }))
  const startedAt = Date.now()
  warnIfBusy()
  const hasNice = spawnSync('nice', ['true']).status === 0
  const results: StepResult[] = []
  for (const [i, step] of steps.entries()) {
    const left = budgetExceeded(steps, i, startedAt, opts.budget)
    if (left) {
      summarize(results, (Date.now() - startedAt) / 1000)
      throw new GateError(`budget of ${opts.budget} min exceeded; ${left.length} batch(es) NOT run:\n  ${left.join('\n  ')}`, EXIT_BUDGET)
    }
    process.stdout.write(`\n> ${step.section}: ${step.label} ... `)
    const r = await runStep(step, ROOT, hasNice)
    console.log(`${r.ok ? 'ok' : 'FAIL'} (${r.seconds.toFixed(1)}s)`)
    results.push(r)
  }
  return summarize(results, (Date.now() - startedAt) / 1000) ? 0 : 1
}

if (import.meta.main) main().then((code) => process.exit(code), (e: Error) => { console.error(`test:impacted: ${e.message}`); process.exit(e instanceof GateError ? e.exitCode : 2) })
