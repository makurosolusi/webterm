// On-demand diagnostics per workspace: `tsc --noEmit --watch` kept alive in the background and one
// `eslint -f json .` per run, parsed into one Problems list (VS Code tasks + problem matchers,
// see problems.parse.ts). Zero-config: tools are the workspace's OWN local binaries
// (`node_modules/.bin/tsc` with a `tsconfig.json`, `node_modules/.bin/eslint`); a workspace with
// neither reports `tools: []` instead of guessing a global install.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AppendEventInput } from '../events/eventModel'
import { parseEslintJson, TscWatchMatcher, type Problem } from './problems.parse'

/** Stored problems per workspace (the panel pages through them). */
export const PROBLEMS_MAX = 2000
export const ESLINT_TIMEOUT_MS = 120_000

export type ProblemTool = 'tsc' | 'eslint'

export interface WatchProcess {
  onStdout(cb: (chunk: string) => void): void
  onExit(cb: (code: number | null) => void): void
  kill(): void
}

export interface ProblemsDeps {
  /** Long-running process (tsc --watch). */
  spawn(bin: string, args: string[], cwd: string): WatchProcess
  /** One-shot process; resolves stdout even on a non-zero exit (eslint exits 1 when it finds problems). */
  exec(bin: string, args: string[], cwd: string, timeoutMs: number): Promise<string>
  exists(path: string): boolean
  record(input: AppendEventInput): void
  now?: () => number
}

export interface ProblemsState {
  /** A run was requested for this workspace (false = never checked). */
  ran: boolean
  running: boolean
  tools: ProblemTool[]
  problems: Problem[]
  errors: number
  warnings: number
  updatedAt: number | null
  /** Last tool failure, e.g. eslint printed non-JSON. */
  error?: string
}

interface Entry { cwd: string; tools: ProblemTool[]; ts: Problem[]; eslint: Problem[]; tsc?: WatchProcess; updatedAt: number | null; error?: string }

const bin = (cwd: string, name: string): string => join(cwd, 'node_modules', '.bin', name)

export function detectTools(cwd: string, exists: (p: string) => boolean = existsSync): ProblemTool[] {
  const tools: ProblemTool[] = []
  if (exists(bin(cwd, 'tsc')) && exists(join(cwd, 'tsconfig.json'))) tools.push('tsc')
  if (exists(bin(cwd, 'eslint'))) tools.push('eslint')
  return tools
}

export class ProblemsService {
  private ws = new Map<string, Entry>()

  constructor(private deps: ProblemsDeps) {}

  /** Start (or re-run) diagnostics for a workspace. tsc keeps watching; eslint runs once per call. */
  async run(workspaceId: string, cwd: string): Promise<ProblemsState> {
    let e = this.ws.get(workspaceId)
    if (!e || e.cwd !== cwd) {
      this.stop(workspaceId)
      e = { cwd, tools: detectTools(cwd, this.deps.exists), ts: [], eslint: [], updatedAt: null }
      this.ws.set(workspaceId, e)
    }
    const entry = e
    if (entry.tools.includes('tsc') && !entry.tsc) {
      const matcher = new TscWatchMatcher(cwd)
      const p = this.deps.spawn(bin(cwd, 'tsc'), ['--noEmit', '--watch', '--pretty', 'false', '--preserveWatchOutput'], cwd)
      entry.tsc = p
      p.onStdout((chunk) => { const cycle = matcher.feed(chunk); if (cycle) { entry.ts = cycle; this.updated(workspaceId, entry) } })
      p.onExit((code) => { if (entry.tsc === p) { entry.tsc = undefined; if (code) entry.error = `tsc exited with code ${code}` } })
    }
    if (entry.tools.includes('eslint')) {
      try {
        entry.eslint = parseEslintJson(await this.deps.exec(bin(cwd, 'eslint'), ['-f', 'json', '.'], cwd, ESLINT_TIMEOUT_MS))
        entry.error = undefined
      } catch (err) {
        entry.error = `eslint failed: ${err instanceof Error ? err.message : String(err)}`
      }
      this.updated(workspaceId, entry)
    }
    return this.state(workspaceId)
  }

  stop(workspaceId: string): void {
    const e = this.ws.get(workspaceId)
    if (!e?.tsc) return
    const p = e.tsc
    e.tsc = undefined
    p.kill()
  }

  stopAll(): void { for (const id of this.ws.keys()) this.stop(id) }

  state(workspaceId: string): ProblemsState {
    const e = this.ws.get(workspaceId)
    if (!e) return { ran: false, running: false, tools: [], problems: [], errors: 0, warnings: 0, updatedAt: null }
    const problems = [...e.ts, ...e.eslint]
    return {
      ran: true, running: !!e.tsc, tools: e.tools, problems: problems.slice(0, PROBLEMS_MAX),
      errors: problems.filter((p) => p.severity === 'error').length,
      warnings: problems.filter((p) => p.severity !== 'error').length,
      updatedAt: e.updatedAt, ...(e.error ? { error: e.error } : {}),
    }
  }

  private updated(workspaceId: string, e: Entry): void {
    e.updatedAt = (this.deps.now ?? Date.now)()
    const s = this.state(workspaceId)
    this.deps.record({
      kind: 'problems.updated',
      source: 'problems',
      actor: 'problems',
      subject: `workspace:${workspaceId}`,
      workspaceId,
      trust: 'trusted',
      // Counts and locations only; messages can quote source text.
      payload: { errors: s.errors, warnings: s.warnings, tools: e.tools, files: [...new Set(s.problems.map((p) => p.file))].slice(0, 20) },
    })
  }
}
