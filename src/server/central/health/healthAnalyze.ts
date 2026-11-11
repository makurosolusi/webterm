// Deep analysis (H4): one headless, read-only Claude Code run per project maps structural problems and
// tech debt; the server verifies every claim (healthAnalyzeVerify.ts) before it becomes a finding.
// Isolation mirrors the other Claude helpers (claudeStructured.ts) plus the planner's read-only tool set
// (dag.planner.ts): `--tools` RESTRICTS to Read/Grep/Glob (`--allowedTools` only pre-approves them),
// `--disallowedTools` carries scoped Read deny rules for secrets (docs: code.claude.com/docs/en/cli-reference,
// "a scoped rule leaves the tool available and denies only calls that match"), `dontAsk` refuses anything
// not pre-approved, no MCP, no user/project settings or hooks, no session file, a USD budget and turn cap.
import type { Database } from 'bun:sqlite'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { HealthRule, HealthScanView } from '../../../shared/centralHealth'
import { SECRET_DOTENV_FILES } from '../../agentSandbox'
import { centralClaudeLaunch } from '../../claudeLauncher/claudeLauncher'
import { claudeEnv } from '../../claudeProvider/claudeProvider.store'
import { recordHelperUsage, type HelperUsage } from '../../cost/costCapture'
import { allRows } from '../../ledger/ledgerCore'
import { activeLedgerRuntime } from '../../ledger/ledgerRuntimeState'
import { createLogger } from '../../logs'
import { modelRequest } from '../../models/modelRequest'
import { projectRepo } from '../../orchestratorRunProduction'
import { parseStructuredAnswer, withTimeout, type StructuredAnswer } from '../context/claudeStructured'
import { claudeChildEnv } from '../runtime/claudeOptions'
import { ANALYSIS_SCHEMA, analysisPrompt, type AnalysisContext } from './healthAnalyzePrompt'
import { verifyAnalysis, type DropCounts } from './healthAnalyzeVerify'
import { DEFAULT_MAX_FILES, isSkippedPath, readText, trackedFiles } from './healthScan'
import { createHealthStore, type HealthStore } from './healthStore'

/** One analysis per project per this interval (counted from the last start, failed runs included). */
export const HEALTH_ANALYZE_COOLDOWN_MS = 60 * 60 * 1000
export const ANALYZE_BUDGET_USD = 0.5
export const ANALYZE_MAX_TURNS = 40
export const ANALYZE_TIMEOUT_MS = 5 * 60_000
/** Mapping a repo needs more than the helpers' haiku; the provider's own model wins (modelRequest). */
export const ANALYZE_MODEL = 'sonnet'
export const ANALYZE_TOOLS = ['Read', 'Grep', 'Glob'] as const
/**
 * Secret files the sub-agent may not read. Read rules also apply to Grep/Glob. `.env` templates stay
 * readable (same list as agentSandbox). `*secret*` is narrowed to data files: a bare `*secret*` would
 * also hide source such as `redactSecrets.ts`, which is exactly the risky code worth reviewing.
 */
export const ANALYZE_READ_DENY: readonly string[] = [
  ...SECRET_DOTENV_FILES.map((f) => `Read(**/${f})`),
  'Read(**/*.pem)', 'Read(**/*.key)', 'Read(**/*.p12)', 'Read(**/*.pfx)', 'Read(**/credentials*.json)',
  'Read(**/*secret*.json)', 'Read(**/*secret*.yaml)', 'Read(**/*secret*.yml)', 'Read(**/*secret*.txt)', 'Read(**/secrets/**)',
]
const LARGEST_FILES = 20
const STDOUT_MAX = 2 * 1024 * 1024
const RULES_FILE_MAX = 256 * 1024
const ANALYZE_KIND = 'health_analysis'
const ANALYSIS_RULES: HealthRule[] = ['analysis']

const log = createLogger('central.health')
const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** The model port: prompt + schema + repo folder in, structured output + usage out. Tests inject a fake. */
export type AnalysisRun = (req: { prompt: string; schema: object; cwd: string }, signal: AbortSignal) => Promise<StructuredAnswer>

/** The analysis `claude -p` argv (after the launcher's own argv); `model: null` passes no `--model`. */
export function analyzeArgv(model: string | null): string[] {
  return ['-p', '--output-format', 'json', '--json-schema', JSON.stringify(ANALYSIS_SCHEMA), ...(model === null ? [] : ['--model', model]),
    '--tools', ANALYZE_TOOLS.join(','), '--allowedTools', ANALYZE_TOOLS.join(','), '--disallowedTools', ANALYZE_READ_DENY.join(','),
    '--permission-mode', 'dontAsk', '--strict-mcp-config', '--setting-sources', '', '--disable-slash-commands', '--no-session-persistence',
    '--max-turns', String(ANALYZE_MAX_TURNS), '--max-budget-usd', String(ANALYZE_BUDGET_USD)]
}

/** Production runner: the Central launcher's claude, provider env applied like every helper; abort kills the child. */
export function createAnalysisRunner(opts: { bin?: string } = {}): AnalysisRun {
  return (req, signal) => new Promise<StructuredAnswer>((resolve, reject) => {
    if (signal.aborted) { reject(new Error('health analysis: aborted before start')); return }
    const env = claudeEnv(claudeChildEnv(process.env))
    const request = modelRequest(ANALYZE_MODEL, env)
    const argv = analyzeArgv(request.flag)
    const [cmd, ...args] = opts.bin ? [opts.bin, ...argv] : [...centralClaudeLaunch().argv, ...argv]
    const child = spawn(cmd as string, args, { cwd: req.cwd, env, stdio: ['pipe', 'pipe', 'ignore'], shell: false })
    let out = ''
    const kill = (): void => { child.kill('SIGKILL') }
    signal.addEventListener('abort', kill, { once: true })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { if (out.length < STDOUT_MAX) out += chunk })
    child.on('error', (err) => reject(new Error(`health analysis: claude spawn failed in ${req.cwd}: ${err.message}`)))
    child.on('close', (code) => {
      signal.removeEventListener('abort', kill)
      if (code !== 0) { reject(new Error(`health analysis: claude exited ${code}`)); return }
      try { resolve(parseStructuredAnswer(out, request.requested)) } catch (err) { reject(new Error(`health analysis: ${errorText(err)}`, { cause: err })) }
    })
    child.stdin.end(req.prompt)
  })
}

/** Books the run's usage in the active cost ledger (none in tests/before boot). */
function bookInLedger(usage: HelperUsage, scanId: string): void {
  const ledger = activeLedgerRuntime()
  if (ledger) recordHelperUsage(ledger.db, ANALYZE_KIND, usage, { id: scanId })
}

export type AnalyzeStart =
  | { ok: true; scan: HealthScanView; done: Promise<HealthScanView> }
  | { ok: false; code: 'analysis_running' }
  | { ok: false; code: 'cooldown'; retryAt: number }

export interface HealthAnalyzer {
  /**
   * Starts an analysis unless one runs or the cooldown holds. The scan row is written before this returns;
   * `done` never rejects (a failure ends the scan as `failed`). Throws only when the row cannot be written.
   */
  start(projectId: string): AnalyzeStart
  running(projectId: string): boolean
  /** When the next analysis may start, or null when it may start now. */
  retryAt(projectId: string): number | null
  /** The newest analysis scan of the project. */
  latest(projectId: string): HealthScanView | null
  /** Claims the last analysis in this process dropped, by reason (null after a restart). */
  dropped(projectId: string): DropCounts | null
}

export interface HealthAnalyzerDeps {
  db: Database
  now(): number
  run?: AnalysisRun
  cwdOf?(projectId: string): string | null
  book?(usage: HelperUsage, scanId: string): void
  /** Global rules file a cited source may come from (default `~/.claude/CLAUDE.md`; read only). */
  globalRulesPath?: string | null
}

/** Measured facts for the prompt: open findings per rule and the largest tracked files. */
async function analysisContext(db: Database, projectId: string, cwd: string, tracked: readonly string[]): Promise<AnalysisContext> {
  const openByRule = Object.fromEntries(allRows(db, `SELECT rule, COUNT(*) AS n FROM central_finding WHERE project_id = ? AND status = 'open' GROUP BY rule`, projectId)
    .map((r) => [String(r['rule']), Number(r['n'])]))
  const sizes: Array<{ file: string; bytes: number }> = []
  for (const file of tracked.filter((p) => !isSkippedPath(p)).slice(0, DEFAULT_MAX_FILES)) {
    const info = await stat(join(cwd, file)).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null // tracked but deleted in the work tree
      throw new Error(`health analysis: stat ${file} in ${cwd} failed: ${err.message}`)
    })
    if (info?.isFile()) sizes.push({ file, bytes: info.size })
  }
  return { openByRule, largest: sizes.sort((a, b) => b.bytes - a.bytes).slice(0, LARGEST_FILES) }
}

/** Analyzer bound to one ledger db. */
export function createHealthAnalyzer(deps: HealthAnalyzerDeps): HealthAnalyzer {
  const { db, now } = deps
  const store: HealthStore = createHealthStore(db, now)
  const run = deps.run ?? createAnalysisRunner()
  const cwdOf = deps.cwdOf ?? ((id: string) => projectRepo(db, id))
  const book = deps.book ?? bookInLedger
  const globalRules = deps.globalRulesPath === undefined ? join(homedir(), '.claude', 'CLAUDE.md') : deps.globalRulesPath
  const inFlight = new Map<string, Promise<HealthScanView>>()
  const droppedBy = new Map<string, DropCounts>()

  const failed = (started: HealthScanView, error: string): HealthScanView => {
    try {
      return store.failScan(started.id, error)
    } catch (err) {
      log.error('health.analyze_fail_record_failed', `could not record failure of analysis ${started.id}`, { scanId: started.id, projectId: started.projectId, error: errorText(err) })
      return { ...started, status: 'failed', finishedAt: now(), error }
    }
  }

  async function ruleTexts(cwd: string, tracked: ReadonlySet<string>): Promise<string[]> {
    const files = [...(tracked.has('CLAUDE.md') ? [join(cwd, 'CLAUDE.md')] : []), ...(globalRules && existsSync(globalRules) ? [globalRules] : [])]
    const texts = await Promise.all(files.map((f) => readText(f, RULES_FILE_MAX)))
    return texts.filter((t): t is string => t !== null)
  }

  async function execute(started: HealthScanView): Promise<HealthScanView> {
    const { id: scanId, projectId } = started
    const cwd = cwdOf(projectId)
    if (cwd === null) return failed(started, `project ${projectId} has no repository folder to analyse`)
    try {
      const tracked = await trackedFiles(cwd)
      const prompt = analysisPrompt(await analysisContext(db, projectId, cwd, tracked))
      const answer = await withTimeout((signal) => run({ prompt, schema: ANALYSIS_SCHEMA, cwd }, signal), ANALYZE_TIMEOUT_MS, 'health analysis')
      // Booking never fails the analysis: the answer is already paid for.
      try { book(answer.usage, scanId) } catch (err) {
        log.warn('health.analyze_usage_book_failed', `usage of analysis ${scanId} could not be booked`, { scanId, error: errorText(err) })
      }
      const set = new Set(tracked)
      const verified = await verifyAnalysis(answer.output, { cwd, tracked: set, ruleTexts: await ruleTexts(cwd, set) })
      droppedBy.set(projectId, verified.dropped)
      // `truncated: true`: a model names a sample of problems, so a finding it did not repeat is not fixed.
      return store.finishScan(scanId, { drafts: verified.drafts, rules: ANALYSIS_RULES, filesScanned: verified.checked, truncated: true }).scan
    } catch (err) {
      log.warn('health.analyze_failed', `health analysis ${scanId} of project ${projectId} failed`, { scanId, projectId, error: errorText(err) })
      return failed(started, `analysis failed: ${errorText(err)}`)
    }
  }

  function retryAt(projectId: string): number | null {
    const last = store.lastScanAt(projectId, 'analysis')
    return last !== null && now() - last < HEALTH_ANALYZE_COOLDOWN_MS ? last + HEALTH_ANALYZE_COOLDOWN_MS : null
  }

  return {
    start(projectId) {
      if (inFlight.has(projectId)) return { ok: false, code: 'analysis_running' }
      const until = retryAt(projectId)
      if (until !== null) return { ok: false, code: 'cooldown', retryAt: until }
      const scan = store.startScan(projectId, 'analysis')
      const done = execute(scan).finally(() => inFlight.delete(projectId))
      inFlight.set(projectId, done)
      return { ok: true, scan, done }
    },
    running: (projectId) => inFlight.has(projectId),
    retryAt,
    latest: (projectId) => store.latestScan(projectId, 'analysis'),
    dropped: (projectId) => droppedBy.get(projectId) ?? null,
  }
}

const analyzers = new WeakMap<Database, HealthAnalyzer>()

/** The process-wide analyzer of `db`; `deps` only apply on first use (tests install a fake runner this way). */
export function healthAnalyzerFor(db: Database, now: () => number, deps: Omit<HealthAnalyzerDeps, 'db' | 'now'> = {}): HealthAnalyzer {
  let analyzer = analyzers.get(db)
  if (!analyzer) {
    analyzer = createHealthAnalyzer({ db, now, ...deps })
    analyzers.set(db, analyzer)
  }
  return analyzer
}
