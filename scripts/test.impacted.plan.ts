// Turns "which files changed" into "which tests to run" for `npm run test:impacted`. Pure: the file
// system is injected, so scripts/test.impacted.plan.bun.test.ts can drive it with a tiny fixture.
import { posix } from 'node:path'
import { buildReverseGraph, dependentsOf, dependentsWithin } from './test.impacted.graph'
import { POLICY_MANIFEST, type PolicyDomain } from './test.policy.manifest'

export type PlanFs = {
  /** Every tracked-or-present repo-relative file under src/ and scripts/. */
  files: string[]
  read: (file: string) => string
  /** True for files that still exist (a deleted file cannot be run). */
  exists: (file: string) => boolean
}

export type Plan = {
  /** Vitest test files to run directly (changed tests). */
  vitestTests: string[]
  /** Unchanged vitest tests our own import graph reaches (dynamic imports, barrels, mocked paths that `vitest related` misses). */
  vitestGraph: string[]
  /** Changed source files to hand to `vitest related`. */
  vitestRelated: string[]
  /** bun test files, `.real.` excluded. */
  bun: string[]
  /** `.real.bun.test.ts` files; only when they themselves changed. */
  bunReal: string[]
  policy: { vitest: string[]; bun: string[]; reasons: string[] }
}

export const isTest = (f: string): boolean => /\.test\.tsx?$/.test(f)
export const isBunTest = (f: string): boolean => /\.bun\.test\.ts$/.test(f)
export const isRealBunTest = (f: string): boolean => /\.real\.bun\.test\.ts$/.test(f)
/** vitest only discovers tests under these trees (vite.config.ts `include`). */
const isVitestTest = (f: string): boolean => isTest(f) && !isBunTest(f) && /^src\/(client|server|shared)\//.test(f)
const isSourceFile = (f: string): boolean => /\.(tsx?|json)$/.test(f) && !isTest(f)

/** Import hops followed for the vitest graph complement; deeper hubs (App, canvas) would drag in dozens of DOM suites. */
export const VITEST_GRAPH_DEPTH = 3

/** Build/test infrastructure: a change here can break any guard, so every policy domain runs. */
const INFRA = /^(package\.json|bun\.lock|bunfig\.toml|vite\.config\.ts|tsconfig[^/]*\.json|electrobun\.config\.ts|components\.json|scripts\/|\.github\/|src\/test[^/]*\.setup\.ts)/

const ALL_DOMAINS: PolicyDomain[] = ['client', 'server', 'shared', 'docs', 'all']

/** Policy domains a set of changed files triggers, each with the files that caused it. */
export function policyDomainsFor(changed: string[]): Map<PolicyDomain, string[]> {
  const why = new Map<PolicyDomain, string[]>()
  const add = (d: PolicyDomain, f: string): void => { why.set(d, [...(why.get(d) ?? []), f]) }
  for (const f of changed) {
    if (INFRA.test(f) || isTest(f)) { for (const d of ALL_DOMAINS) add(d, f); continue }
    if (f.startsWith('src/client/')) { add('client', f); add('all', f) }
    else if (f.startsWith('src/server/')) { add('server', f); add('all', f) }
    else if (f.startsWith('src/shared/')) { for (const d of ['client', 'server', 'shared', 'all'] as const) add(d, f) }
    else if (f.startsWith('src/')) add('all', f)
    else if (f.startsWith('docs/') || /\.md$/.test(f)) add('docs', f)
  }
  return why
}

const reasonLine = (d: PolicyDomain, files: string[]): string =>
  `${d}: ${files.slice(0, 2).join(', ')}${files.length > 2 ? ` (+${files.length - 2} more)` : ''}`

/** The sibling bun tests of `file`: `x.ts` -> `x.bun.test.ts` and `x.<topic>.bun.test.ts`. */
function pairedBunTests(file: string, all: string[]): string[] {
  const dir = posix.dirname(file)
  const stem = posix.basename(file).replace(/\.tsx?$/, '')
  return all.filter((t) => posix.dirname(t) === dir && isBunTest(t) && !isRealBunTest(t) && posix.basename(t).startsWith(`${stem}.`))
}

export function buildPlan(changedAll: string[], fs: PlanFs, opts: { policy: boolean }): Plan {
  const sorted = (s: Iterable<string>): string[] => [...new Set(s)].sort()
  const changed = changedAll.filter((f) => fs.exists(f))

  const policyFiles = new Set<string>()
  const reasons: string[] = []
  if (opts.policy) {
    for (const [d, files] of policyDomainsFor(changedAll)) {
      reasons.push(reasonLine(d, files))
      for (const f of POLICY_MANIFEST[d]) if (fs.exists(f)) policyFiles.add(f)
    }
  }

  const changedTests = changed.filter(isTest)
  const changedSources = changed.filter(isSourceFile)
  const reverse = buildReverseGraph(fs.files, fs.read)
  const impacted = [...dependentsOf(changedSources, reverse), ...changedSources.flatMap((f) => pairedBunTests(f, fs.files))]
  const bunSet = new Set([...impacted.filter((f) => isBunTest(f) && !isRealBunTest(f)), ...changedTests.filter((f) => isBunTest(f) && !isRealBunTest(f))])

  const notPolicy = (f: string): boolean => !policyFiles.has(f)
  const changedSet = new Set(changedTests)
  const graphTests = sorted([...dependentsWithin(changedSources, reverse, VITEST_GRAPH_DEPTH)].filter((f) => isVitestTest(f) && !changedSet.has(f))).filter(notPolicy)
  const policyList = sorted(policyFiles)
  return {
    vitestTests: sorted(changedTests.filter(isVitestTest).filter(notPolicy)),
    vitestGraph: graphTests,
    vitestRelated: sorted(changedSources.filter((f) => /^src\/(client|server|shared)\//.test(f) && /\.tsx?$/.test(f))),
    bun: sorted(bunSet).filter(notPolicy),
    bunReal: sorted(changedTests.filter(isRealBunTest)),
    policy: { vitest: policyList.filter((f) => !isBunTest(f)), bun: policyList.filter(isBunTest), reasons },
  }
}
