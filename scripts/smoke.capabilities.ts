#!/usr/bin/env bun
// Real-model behavior smoke for agent capabilities (docs/smoke-capabilities.md): boots a throwaway webterm
// server, sends one prompt per profile to a real Claude, and grades the TOOL EVIDENCE, not the model's words.
//
//   bun scripts/smoke.capabilities.ts [--profile <id>]      (npm run smoke:capabilities)
//
// Exit: 0 all PASS, 1 any FAIL, 2 bad arguments. Costs real tokens and needs `claude` auth + a browser binary.
import { CASES, PROFILE_IDS, caseLabel, gradeCase, runCase, type SmokeCase } from './smoke.capabilities.cases'
import { seedBoard, type RunResult } from './smoke.capabilities.run'
import { startServer, type SmokeServer } from './smoke.capabilities.server'

const USAGE = `usage: bun scripts/smoke.capabilities.ts [--profile <id>] [--verbose]\n  profiles: ${PROFILE_IDS.join(', ')}`

const VERBOSE = process.argv.includes('--verbose')

function parseProfile(args: readonly string[]): string | undefined {
  if (args.includes('--help') || args.includes('-h')) { console.log(USAGE); process.exit(0) }
  const argv = args.filter((a) => a !== '--verbose')
  const i = argv.indexOf('--profile')
  if (i < 0 && argv.length === 0) return undefined
  const id = i >= 0 ? argv[i + 1] : undefined
  if (id === undefined || !(PROFILE_IDS as readonly string[]).includes(id) || argv.length !== 2) {
    console.error(`smoke:capabilities: ${id === undefined ? 'bad arguments' : `unknown profile ${id}`}\n${USAGE}`)
    process.exit(2)
  }
  return id
}

interface Row { label: string; pass: boolean; evidence: string; ms: number; model: string; cost: string }

/** One case; a run that broke on the network is retried once, a behavior FAIL never is. */
async function execute(s: SmokeServer, c: SmokeCase): Promise<Row> {
  const started = Date.now()
  let run: RunResult
  let note = ''
  try {
    run = await runCase(s, c)
    if (run.failure?.network) { note = ` [retried after network failure: ${run.failure.detail.slice(0, 60)}]`; run = await runCase(s, c) }
  } catch (err) {
    return { label: caseLabel(c), pass: false, evidence: `FAIL harness error: ${err instanceof Error ? err.message : String(err)}`, ms: Date.now() - started, model: '?', cost: '-' }
  }
  const verdict = gradeCase(c, run.evidence)
  if (VERBOSE) {
    for (const t of run.evidence.tools) console.error(`  tool ${t.name} [${t.state}] ${t.command.slice(0, 100)} ${t.code}`)
    console.error(`  answer: ${run.evidence.text.replace(/\s+/g, ' ').slice(0, 400)}`)
  }
  const broke = run.failure ? ` [run: ${run.failure.detail.slice(0, 100)}]` : ''
  const pass = verdict.pass && !(run.failure && /^timeout/.test(run.failure.detail))
  return { label: caseLabel(c), pass, evidence: `${verdict.evidence}${broke}${note}`, ms: Date.now() - started, model: run.model, cost: run.costUsd === null ? '-' : `$${run.costUsd.toFixed(4)}` }
}

function printTable(rows: readonly Row[]): void {
  console.log('| profile | result | evidence | duration | cost | model |')
  console.log('|---|---|---|---|---|---|')
  for (const r of rows) console.log(`| ${r.label} | ${r.pass ? 'PASS' : 'FAIL'} | ${r.evidence.replace(/\|/g, '/')} | ${(r.ms / 1000).toFixed(1)}s | ${r.cost} | ${r.model} |`)
}

async function main(): Promise<void> {
  const only = parseProfile(process.argv.slice(2))
  const cases = CASES.filter((c) => only === undefined || c.profile === only)
  const server = await startServer()
  const onSignal = (): void => void server.stop().finally(() => process.exit(130))
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  const rows: Row[] = []
  try {
    await seedBoard(server)
    for (const c of cases) {
      console.error(`running ${caseLabel(c)} ...`)
      rows.push(await execute(server, c))
    }
  } finally {
    await server.stop()
  }
  printTable(rows)
  process.exitCode = rows.some((r) => !r.pass) ? 1 : 0
}

main().catch((err: unknown) => {
  console.error('smoke:capabilities failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
