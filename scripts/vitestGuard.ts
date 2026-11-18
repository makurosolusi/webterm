// vitest `globalSetup` (vite.config.ts): refuses a whole-suite run unless the owner / CI opted in.
// Runs in the main vitest process, so process.argv is the real CLI. `vitest run <file>`,
// `vitest related --run <files>` and `vitest --changed` pass; see docs/testing.md.
import { decideVitest } from './testGuard.decide'

export default function setup(): void {
  const d = decideVitest(process.argv.slice(2), process.env)
  if (d.allow) return
  console.error(`\n${d.reason}\n`)
  process.exit(2)
}
