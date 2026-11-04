// Problem matchers (pure, vitest-safe).
//
// Imitated from VS Code:
// - `$tsc` pattern and the `tsc-watch` background begin/end patterns, verbatim from
//   microsoft/vscode `extensions/typescript-language-features/package.json` (contributes.problemPatterns
//   at :3060, problemMatchers `tsc-watch` at :3107-3126). `fileLocation: ["relative", "${cwd}"]`:
//   paths are resolved against the task's cwd.
// - ESLint: the documented `eslint -f json` formatter shape (array of `{filePath, messages:
//   [{ruleId, severity 1|2, message, line, column}]}`), which is what vscode-eslint's
//   `$eslint-stylish` matcher reads in text form.
import { isAbsolute, join } from 'node:path'

export type ProblemSeverity = 'error' | 'warning' | 'info'

export interface Problem {
  source: 'ts' | 'eslint'
  /** Absolute path. */
  file: string
  line: number
  column: number
  severity: ProblemSeverity
  code?: string
  message: string
}

export const TSC_PATTERN = /^([^\s].*)[(:](\d+)[,:](\d+)(?:\):\s+|\s+-\s+)(error|warning|info)\s+TS(\d+)\s*:\s*(.*)$/
export const TSC_WATCH_BEGIN = /^\s*(?:message TS6032:|\[?\D*.{1,2}[:.].{1,2}[:.].{1,2}\D*(├\D*\d{1,2}\D+┤)?(?:\]| -)) (Starting compilation in watch mode|File change detected\. Starting incremental compilation)\.\.\./
export const TSC_WATCH_END = /^\s*(?:message TS6042:|\[?\D*.{1,2}[:.].{1,2}[:.].{1,2}\D*(├\D*\d{1,2}\D+┤)?(?:\]| -)) (?:Compilation complete\.|Found \d+ errors?\.) Watching for file changes\./

const resolve = (cwd: string, f: string): string => (isAbsolute(f) ? f : join(cwd, f))

/** One `tsc --pretty false` line, or null when it is not a diagnostic. */
export function parseTscLine(line: string, cwd: string): Problem | null {
  const m = TSC_PATTERN.exec(line.replace(/\r$/, ''))
  if (!m) return null
  return { source: 'ts', file: resolve(cwd, m[1]!), line: Number(m[2]), column: Number(m[3]), severity: m[4] as ProblemSeverity, code: `TS${m[5]}`, message: m[6]! }
}

/** All diagnostics in a `tsc --noEmit` run's output. */
export function parseTscOutput(text: string, cwd: string): Problem[] {
  return text.split('\n').map((l) => parseTscLine(l, cwd)).filter((p): p is Problem => p !== null)
}

/**
 * Background matcher for `tsc --watch`: lines between a begin and an end marker form one cycle;
 * `feed` returns the cycle's problems when its end marker arrives, else null.
 */
export class TscWatchMatcher {
  private cycle: Problem[] = []
  private pending = ''

  constructor(private cwd: string) {}

  feed(chunk: string): Problem[] | null {
    this.pending += chunk
    let done: Problem[] | null = null
    let nl: number
    while ((nl = this.pending.indexOf('\n')) !== -1) {
      const line = this.pending.slice(0, nl)
      this.pending = this.pending.slice(nl + 1)
      if (TSC_WATCH_BEGIN.test(line)) this.cycle = []
      else if (TSC_WATCH_END.test(line)) { done = this.cycle; this.cycle = [] }
      else { const p = parseTscLine(line, this.cwd); if (p) this.cycle.push(p) }
    }
    return done
  }
}

interface EslintMessage { ruleId?: string | null; severity?: number; message?: string; line?: number; column?: number }

/** `eslint -f json` stdout. Throws on non-JSON (the caller reports the run as failed). */
export function parseEslintJson(text: string): Problem[] {
  const files = JSON.parse(text) as Array<{ filePath?: string; messages?: EslintMessage[] }>
  if (!Array.isArray(files)) throw new Error('eslint -f json: expected an array')
  const out: Problem[] = []
  for (const f of files) {
    for (const m of f.messages ?? []) {
      if (typeof f.filePath !== 'string' || typeof m.message !== 'string') continue
      out.push({
        source: 'eslint', file: f.filePath, line: m.line ?? 1, column: m.column ?? 1,
        severity: m.severity === 2 ? 'error' : 'warning', ...(m.ruleId ? { code: m.ruleId } : {}), message: m.message,
      })
    }
  }
  return out
}

/** Plain-text list for an agent ("Fix with agent"), capped at `maxChars`. */
export function formatProblemsForAgent(problems: readonly Problem[], cwd: string, maxChars: number): string {
  const head = `Fix these ${problems.length} problem(s) reported by the type checker / linter in ${cwd}:\n`
  let body = ''
  let shown = 0
  for (const p of problems) {
    const rel = p.file.startsWith(`${cwd}/`) ? p.file.slice(cwd.length + 1) : p.file
    const line = `- ${rel}:${p.line}:${p.column} ${p.severity}${p.code ? ` ${p.code}` : ''}: ${p.message.replace(/\s+/g, ' ')}\n`
    if (head.length + body.length + line.length + 40 > maxChars) break
    body += line
    shown++
  }
  const more = problems.length - shown
  return `${head}${body}${more > 0 ? `(+${more} more not shown)\n` : ''}`.trimEnd()
}
