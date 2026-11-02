#!/usr/bin/env bun
// Soak harness for the central autonomy scheduler (src/server/central/centralAutonomy.ts).
//
// It drives the real `createCentralAutonomy` in-memory with fake projects/plans (see
// soakCentralAutonomyModel.ts): a fake `run` flips one item to `done` and appends a fresh
// `assigned` item, so the loop always has work. This proves scheduler-level invariants (one item
// per tick, no overlap, pause/terminal skip, failure-budget quarantine). It does NOT prove
// anything about a real PTY, Claude run, Telegram, or the ledger/database route behind `run`.
//
// Usage:
//   bun scripts/soakCentralAutonomy.ts --cycles 10000 --projects 2 --fail-every 17 --pause-every 500
//
// Exit code: 0 all invariants held, 1 invariant violation, 2 bad CLI args.

import { InvariantError, runSoak, type SoakOptions, type SoakResult } from './soakCentralAutonomyModel'
import { runScenarios, type ScenarioResult } from './soakCentralAutonomyScenarios'

const USAGE = `usage: bun scripts/soakCentralAutonomy.ts [options]

  --cycles <n>        ticks to run (default 10000)
  --projects <n>      fake project count (default 2)
  --fail-every <n>    every n-th fake run fails; 0 = never (default 0)
  --pause-every <n>   every n-th tick pauses one project for a few ticks; 0 = never (default 0)`

function parseArgs(argv: readonly string[]): SoakOptions {
  const cli: SoakOptions = { cycles: 10_000, projects: 2, failEvery: 0, pauseEvery: 0 }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      console.log(USAGE)
      process.exit(0)
    }
    const next = argv[i + 1]
    const readNumber = (name: string, min: number): number => {
      if (next === undefined) throw new Error(`${name} needs a value`)
      const parsed = Number(next)
      if (!Number.isInteger(parsed) || parsed < min) {
        throw new Error(`${name} expects an integer >= ${min}, got ${next}`)
      }
      i += 1
      return parsed
    }
    switch (arg) {
      case '--cycles':
        cli.cycles = readNumber('--cycles', 1)
        break
      case '--projects':
        cli.projects = readNumber('--projects', 1)
        break
      case '--fail-every':
        cli.failEvery = readNumber('--fail-every', 0)
        break
      case '--pause-every':
        cli.pauseEvery = readNumber('--pause-every', 0)
        break
      default:
        throw new Error(`unknown argument: ${arg}`)
    }
  }
  return cli
}

const fmtMb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(2)} MB`

function printSummary(cli: SoakOptions, soak: SoakResult, scenarios: ScenarioResult[]): void {
  const m = soak.metrics
  console.log('--- soak: central autonomy (in-memory fake projects) ---')
  console.log(
    `config       cycles=${cli.cycles} projects=${cli.projects} failEvery=${cli.failEvery} pauseEvery=${cli.pauseEvery}`
  )
  console.log(`ticks        ${m.ticks} (ran=${m.ticksRan} skipped=${m.ticksSkipped})`)
  console.log(`runs         ${m.runs} (failures=${m.failures})`)
  console.log(`concurrency  max=${m.maxConcurrency} maxRunsPerTick=${m.maxRunsPerTick}`)
  console.log(`overlap      probes=${m.overlapProbes} rejected=${m.overlapRejections}`)
  console.log(
    `paused       ticks_with_paused_project=${m.pausedSkipTicks} quarantined_observations=${soak.quarantinedTicks}`
  )
  console.log(`fake_plans   items_retained=${m.simulatedItems} (harness data, see docs)`)
  console.log(
    `audit        ${Object.entries(m.auditCounts)
      .map(([kind, count]) => `${kind}=${count}`)
      .join(' ')}`
  )
  console.log(
    `heap         before=${fmtMb(soak.heapBefore)} after=${fmtMb(soak.heapAfter)} ` +
      `delta=${fmtMb(soak.heapAfter - soak.heapBefore)}`
  )
  console.log(
    `wall         ${soak.wallMs.toFixed(1)} ms (${((soak.wallMs / m.ticks) * 1000).toFixed(1)} us/tick)`
  )
  console.log('--- invariant scenarios ---')
  for (const scenario of scenarios) console.log(`ok  ${scenario.name} :: ${scenario.detail}`)
  console.log('RESULT: PASS')
}

async function main(): Promise<void> {
  let cli: SoakOptions
  try {
    cli = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`soakCentralAutonomy: ${(error as Error).message}`)
    console.error(USAGE)
    process.exit(2)
  }

  try {
    const soak = await runSoak(cli)
    const scenarios = await runScenarios()
    printSummary(cli, soak, scenarios)
  } catch (error) {
    if (error instanceof InvariantError) {
      console.error(`INVARIANT VIOLATION: ${error.message}`)
      process.exit(1)
    }
    throw error
  }
}

main().catch((error) => {
  console.error('soakCentralAutonomy failed:', error)
  process.exit(1)
})
