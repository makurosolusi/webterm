// `webterm eval run`: replays the promoted eval cases against Central and exits 1 on any regression.
//   bun evalRun.main.ts run [--model fake|real] [--fake-script <file.json>] [--claude <path>] [--db <ledger.db>] [--json]
// `--model fake` (default) is the scripted `claude`; its script maps a case id (or "*") to FakeSteps and
// defaults to a text-only answer. `--model real` runs the `claude` CLI (or `--claude <path>`).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir } from '../config'
import type { FakeStep } from '../central/eval/goldenHarness'
import { openLedgerDb } from '../ledger/migration'
import { promotedEvalCases } from './evalCase.store'
import { replayCases, type ReplayModel, type ReplayVerdict } from './evalReplay'

export const EVAL_USAGE = 'usage: webterm eval run [--model fake|real] [--fake-script <file.json>] [--claude <path>] [--db <ledger.db>] [--json]'
const DEFAULT_FAKE_STEPS: readonly FakeStep[] = [{ text: 'Replay (fake model): no action taken.' }]

export interface EvalIo { out(line: string): void; err(line: string): void }

function flag(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

function modelOf(argv: readonly string[]): ReplayModel {
  const kind = flag(argv, '--model') ?? 'fake'
  if (kind === 'real') {
    const executable = flag(argv, '--claude')
    return { kind: 'real', ...(executable ? { executable } : {}) }
  }
  if (kind !== 'fake') throw new Error(`unknown --model ${kind} (fake|real)`)
  const file = flag(argv, '--fake-script')
  const script = file ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, FakeStep[]>) : {}
  return { kind: 'fake', steps: (c) => script[c.id] ?? script['*'] ?? DEFAULT_FAKE_STEPS }
}

/** Runs the CLI; returns the process exit code (0 all pass/skipped, 1 a failure or error, 2 bad usage). */
export async function runEvalCli(argv: readonly string[], io: EvalIo): Promise<number> {
  if (argv[0] !== 'run') { io.err(EVAL_USAGE); return 2 }
  let model: ReplayModel
  try { model = modelOf(argv) } catch (err) { io.err(`${err instanceof Error ? err.message : String(err)}\n${EVAL_USAGE}`); return 2 }
  const db = openLedgerDb(flag(argv, '--db') ?? join(dataDir(), 'ledger.db'))
  let results: ReplayVerdict[]
  try {
    results = await replayCases(db, promotedEvalCases(db), model)
  } finally {
    ;(db as unknown as { close(): void }).close()
  }
  const count = (v: ReplayVerdict['verdict']): number => results.filter((r) => r.verdict === v).length
  if (argv.includes('--json')) io.out(JSON.stringify({ model: model.kind, results }))
  else {
    for (const r of results) io.out(`${r.verdict.toUpperCase().padEnd(7)} ${r.id}  ${r.detail}`)
    io.out(`${results.length} case(s): ${count('pass')} passed, ${count('fail')} failed, ${count('error')} errored, ${count('skipped')} skipped (model: ${model.kind})`)
  }
  return count('fail') + count('error') > 0 ? 1 : 0
}

if (import.meta.main) {
  const code = await runEvalCli(process.argv.slice(2), { out: (l) => process.stdout.write(`${l}\n`), err: (l) => process.stderr.write(`${l}\n`) })
  process.exit(code)
}
