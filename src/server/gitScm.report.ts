// Pre-push report + push + PR (plan I2-a). The report is Rule 18 made mechanical: the project's own
// test/typecheck/lint scripts are actually run (with timeouts), the outgoing + staged diff is scanned
// for credential-shaped values (`redactSecrets` patterns, the one list) and secret-named files, and
// TODO/FIXME debt is listed. Push is refused until a report exists for the current HEAD that is green,
// or red and explicitly acknowledged; a credential finding can never be acknowledged (Rule 7: stop).
//
// Push imitates Orca `review/commit-push.mdx`: push to origin, set upstream the first time, never
// force (no force-with-lease here at all). PR = `gh pr create --fill` when gh is on PATH.
// Callers (route) have already proven the caller is the human at the UI (`uiOnlyDenial`).
import { existsSync, readFileSync } from 'node:fs'
import npath from 'node:path'
import { binaryOnPath } from './binaryOnPath'
import { git, run, ScmError, scmStatus } from './gitScm'
import { redactSecrets } from './redactSecrets'
import { isSensitivePath } from './repoHygiene'
import type { ScmCheck, ScmFinding, ScmReport } from './gitScm.types'

/** Per script; a full test suite can be slow. Callers (tests) may pass a shorter one. */
export const SCRIPT_TIMEOUT_MS = 10 * 60_000
const PUSH_TIMEOUT_MS = 2 * 60_000
const PR_TIMEOUT_MS = 60_000
const OUTPUT_TAIL = 4000
const FINDINGS_MAX = 200
/** Rule 6 order: test, type check, lint. First script name present wins. */
const CHECKS: readonly { name: string; scripts: readonly string[] }[] = [
  { name: 'test', scripts: ['test'] },
  { name: 'typecheck', scripts: ['typecheck', 'type-check', 'tsc'] },
  { name: 'lint', scripts: ['lint'] },
]
const DEBT_RE = /\b(TODO|FIXME|XXX|HACK)\b/

// ponytail: one report per repo root in memory; a restart means re-running the checks, which is the safe side.
const reports = new Map<string, ScmReport>()

export const latestReport = (root: string): ScmReport | null => reports.get(root) ?? null
export const forgetReportsForTest = (): void => reports.clear()

function scripts(root: string): Record<string, string> | null {
  try {
    const pkg = JSON.parse(readFileSync(npath.join(root, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }
    return pkg.scripts ?? {}
  } catch {
    return null
  }
}

const runner = (root: string) => (existsSync(npath.join(root, 'bun.lock')) || existsSync(npath.join(root, 'bun.lockb')) ? 'bun' : 'npm')

async function runCheck(root: string, name: string, candidates: readonly string[], all: Record<string, string> | null, timeoutMs: number): Promise<ScmCheck> {
  const script = candidates.find((s) => all && s in all)
  if (!all || !script) return { name, status: 'skipped', detail: all ? `no ${candidates.join('/')} script in package.json` : 'no package.json', durationMs: 0, output: '' }
  const cmd = [runner(root), 'run', script]
  const t0 = Date.now()
  const r = await run(cmd[0], cmd.slice(1), { cwd: root, timeoutMs })
  const out = [r.stdout, r.stderr].filter((s) => s.trim()).join('\n')
  return {
    name, status: r.timedOut ? 'timeout' : r.code === 0 ? 'pass' : 'fail', detail: cmd.join(' '),
    durationMs: Date.now() - t0, output: redactSecrets(out.length > OUTPUT_TAIL ? out.slice(-OUTPUT_TAIL) : out),
  }
}

/** Added lines of a unified diff (`git diff` / `git log -p`) -> credential and debt findings. */
export function scanPatch(patch: string): { credentials: ScmFinding[]; debt: ScmFinding[] } {
  const credentials: ScmFinding[] = []
  const debt: ScmFinding[] = []
  let file = ''
  let line = 0
  for (const l of patch.split('\n')) {
    if (l.startsWith('+++ ')) {
      file = l === '+++ /dev/null' ? '' : l.slice(4).replace(/^b\//, '')
      if (file && isSensitivePath(file)) credentials.push({ path: file, line: 0, text: 'secret-named file in the diff' })
      continue
    }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(l)
    if (h) { line = +h[1]; continue }
    if (l.startsWith('+')) {
      const text = l.slice(1)
      // The value itself never leaves this function: only where it is.
      if (redactSecrets(text) !== text) credentials.push({ path: file, line, text: 'credential-shaped value' })
      if (DEBT_RE.test(text)) debt.push({ path: file, line, text: redactSecrets(text.trim()).slice(0, 200) })
      line++
    } else if (l.startsWith(' ')) line++
  }
  return { credentials: credentials.slice(0, FINDINGS_MAX), debt: debt.slice(0, FINDINGS_MAX) }
}

async function headOf(root: string): Promise<string> {
  const r = await git(root, ['rev-parse', '--verify', '-q', 'HEAD'])
  return r.code === 0 ? r.stdout.trim() : ''
}

/** What a push would publish plus what is staged for the next commit, as one patch. */
async function outgoingPatch(root: string, head: string): Promise<string> {
  const flags = ['--no-color', '--no-ext-diff', '-U0']
  const staged = await git(root, ['diff', '--cached', ...flags])
  // Commits on HEAD that no remote-tracking branch has yet: exactly what `git push` would send.
  const out = head ? await git(root, ['log', '-p', ...flags, '--format=', 'HEAD', '--not', '--remotes']) : null
  return `${staged.stdout}\n${out?.stdout ?? ''}`
}

/** Runs the checks and scans, stores the report for `root` and returns it. */
export async function makeReport(root: string, opts: { timeoutMs?: number } = {}): Promise<ScmReport> {
  const head = await headOf(root)
  const all = scripts(root)
  const checks: ScmCheck[] = []
  // Sequential: test suites in one repo fight over ports and temp dirs when run together.
  for (const c of CHECKS) checks.push(await runCheck(root, c.name, c.scripts, all, opts.timeoutMs ?? SCRIPT_TIMEOUT_MS))
  const { credentials, debt } = scanPatch(await outgoingPatch(root, head))
  const green = checks.every((c) => c.status === 'pass' || c.status === 'skipped') && credentials.length === 0
  const report: ScmReport = { root, head, createdAt: Date.now(), checks, credentials, debt, green }
  reports.set(root, report)
  return report
}

/** Pushes HEAD's branch to origin. Refused without a fresh green (or acknowledged) report. */
export async function push(root: string, acknowledge: boolean): Promise<{ ok: true; output: string }> {
  const report = reports.get(root)
  if (!report) throw new ScmError('no_report', 409, 'Run the pre-push checks first.')
  if (report.head !== (await headOf(root))) throw new ScmError('report_stale', 409, 'HEAD moved since the pre-push checks ran; run them again.')
  if (report.credentials.length) throw new ScmError('credentials_found', 409, `The outgoing diff holds ${report.credentials.length} credential finding(s). Remove them (and rotate the secret if it was ever pushed); this cannot be acknowledged.`)
  if (!report.green && !acknowledge) throw new ScmError('report_red', 409, 'Pre-push checks failed. Fix them, or acknowledge the failures explicitly to push anyway.')
  const s = await scmStatus(root)
  if (!s.branch) throw new ScmError('detached', 409, 'HEAD is detached; check out a branch to push.')
  let args = ['push']
  if (!s.upstream) {
    if ((await git(root, ['remote', 'get-url', 'origin'])).code !== 0) throw new ScmError('no_remote', 400, 'This repo has no "origin" remote.')
    args = ['push', '-u', 'origin', 'HEAD']
  }
  const r = await git(root, args, undefined, PUSH_TIMEOUT_MS)
  const output = redactSecrets([r.stdout, r.stderr].filter((x) => x.trim()).join('\n').slice(-OUTPUT_TAIL))
  if (r.code !== 0) throw new ScmError('push_failed', 409, r.timedOut ? 'git push timed out.' : `git push failed: ${output}`)
  return { ok: true, output }
}

/** `gh pr create --fill` for the pushed branch; gh must be on PATH. */
export async function createPr(root: string): Promise<{ ok: true; url: string }> {
  if (!binaryOnPath('gh')) throw new ScmError('gh_missing', 400, 'The GitHub CLI (gh) is not installed.')
  const s = await scmStatus(root)
  if (!s.upstream || s.ahead > 0) throw new ScmError('not_pushed', 409, 'Push the branch before creating a pull request.')
  const r = await run('gh', ['pr', 'create', '--fill'], { cwd: root, timeoutMs: PR_TIMEOUT_MS })
  const out = redactSecrets([r.stdout, r.stderr].filter((x) => x.trim()).join('\n').slice(-OUTPUT_TAIL))
  if (r.code !== 0) throw new ScmError('pr_failed', 502, r.timedOut ? 'gh pr create timed out.' : `gh pr create failed: ${out}`)
  return { ok: true, url: r.stdout.trim().split('\n').at(-1) ?? '' }
}
