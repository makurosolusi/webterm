import { describe, expect, test } from 'bun:test'
import { buildReverseGraph, dependentsOf, importSpecifiers } from './test.impacted.graph'
import { buildPlan, policyDomainsFor, type PlanFs } from './test.impacted.plan'
import { buildSteps, failedFiles, lowPriority } from './test.impacted.run'
import { parseOptions } from './test.impacted'
import { POLICY_MANIFEST } from './test.policy.manifest'

const SOURCES: Record<string, string> = {
  'src/server/a.ts': 'export const a = 1',
  'src/server/b.ts': "import { a } from './a'\nexport const b = a",
  'src/server/c.ts': 'export const c = 3',
  'src/server/d.ts': "export * from './b.js'",
  'src/server/b.bun.test.ts': "import { b } from './b'",
  'src/server/d.bun.test.ts': "import './d'",
  'src/server/c.bun.test.ts': "import { c } from './c'",
  'src/server/c.extra.bun.test.ts': 'test("x")',
  'src/server/other.bun.test.ts': 'test("unrelated")',
  'src/server/a.real.bun.test.ts': "import { a } from './a'",
  'src/server/entry.bun.test.ts': "const ENTRY = join(import.meta.dirname, 'a.ts')",
  'src/client/ui.ts': 'export const ui = 1',
  'src/client/ui.test.ts': "import { ui } from './ui'",
}
const fixture = (extra: string[] = []): PlanFs => ({
  files: Object.keys(SOURCES),
  read: (f) => SOURCES[f] ?? '',
  exists: (f) => f in SOURCES || extra.includes(f) || Object.values(POLICY_MANIFEST).flat().includes(f),
})

describe('import graph', () => {
  test('parses relative specifiers only', () => {
    expect(importSpecifiers("import a from 'react'\nimport { b } from './b'\nexport * from '../c/d'\nawait import('./lazy')")).toEqual(['./b', '../c/d', './lazy'])
  })

  test('finds transitive dependents, following .js -> .ts specifiers', () => {
    const rev = buildReverseGraph(Object.keys(SOURCES), (f) => SOURCES[f] ?? '')
    const deps = dependentsOf(['src/server/a.ts'], rev)
    expect([...deps].sort()).toEqual(['src/server/a.real.bun.test.ts', 'src/server/b.bun.test.ts', 'src/server/b.ts', 'src/server/d.bun.test.ts', 'src/server/d.ts', 'src/server/entry.bun.test.ts'])
  })
})

describe('vitest import-graph complement', () => {
  const src: Record<string, string> = {
    'src/client/A.tsx': 'export const A = 1',
    'src/client/B.tsx': "export const load = () => import('./A')",
    'src/client/B.test.tsx': "import { load } from './B'",
    'src/client/deep.test.tsx': "import './h4'",
    'src/client/h1.ts': "export * from './A'",
    'src/client/h2.ts': "export * from './h1'",
    'src/client/h3.ts': "export * from './h2'",
    'src/client/h4.ts': "export * from './h3'",
  }
  const fs: PlanFs = { files: Object.keys(src), read: (f) => src[f] ?? '', exists: (f) => f in src }

  test('a test importing B, which imports A dynamically, is selected when A changes', () => {
    expect(buildPlan(['src/client/A.tsx'], fs, { policy: false }).vitestGraph).toContain('src/client/B.test.tsx')
  })

  test('hops beyond the depth cap are not followed, and a changed test is not listed twice', () => {
    const plan = buildPlan(['src/client/A.tsx', 'src/client/B.test.tsx'], fs, { policy: false })
    expect(plan.vitestGraph).not.toContain('src/client/deep.test.tsx')
    expect(plan.vitestGraph).not.toContain('src/client/B.test.tsx')
    expect(plan.vitestTests).toEqual(['src/client/B.test.tsx'])
  })
})

describe('buildPlan', () => {
  test('a leaf change selects importing bun tests, never .real. files, nor unrelated ones', () => {
    const plan = buildPlan(['src/server/a.ts'], fixture(), { policy: false })
    expect(plan.bun).toEqual(['src/server/b.bun.test.ts', 'src/server/d.bun.test.ts', 'src/server/entry.bun.test.ts'])
    expect(plan.bunReal).toEqual([])
    expect(plan.vitestRelated).toEqual(['src/server/a.ts'])
  })

  test('a source file also selects its paired x.bun.test.ts and x.<topic>.bun.test.ts', () => {
    const plan = buildPlan(['src/server/c.ts'], fixture(), { policy: false })
    expect(plan.bun).toEqual(['src/server/c.bun.test.ts', 'src/server/c.extra.bun.test.ts'])
  })

  test('a changed .real. test runs by itself; a changed vitest test runs directly', () => {
    const plan = buildPlan(['src/server/a.real.bun.test.ts', 'src/client/ui.test.ts'], fixture(), { policy: false })
    expect(plan.bunReal).toEqual(['src/server/a.real.bun.test.ts'])
    expect(plan.bun).toEqual([])
    expect(plan.vitestTests).toEqual(['src/client/ui.test.ts'])
  })

  test('a deleted file cannot be run but is still a policy trigger', () => {
    const plan = buildPlan(['src/client/gone.ts'], fixture(), { policy: true })
    expect(plan.vitestRelated).toEqual([])
    expect(plan.policy.reasons[0]).toContain('src/client/gone.ts')
  })

  test('policy files are not repeated in the vitest/bun lists, and --no-policy drops the tier', () => {
    const on = buildPlan(['src/server/featureCapabilities.grep.test.ts'], fixture(['src/server/featureCapabilities.grep.test.ts']), { policy: true })
    expect(on.vitestTests).not.toContain('src/server/featureCapabilities.grep.test.ts')
    expect(on.policy.vitest).toContain('src/server/featureCapabilities.grep.test.ts')
    const off = buildPlan(['src/server/featureCapabilities.grep.test.ts'], fixture(['src/server/featureCapabilities.grep.test.ts']), { policy: false })
    expect(off.policy).toEqual({ vitest: [], bun: [], reasons: [] })
    expect(off.vitestTests).toEqual(['src/server/featureCapabilities.grep.test.ts'])
  })
})

describe('policy triggers', () => {
  const domains = (files: string[]) => [...policyDomainsFor(files).keys()].sort()

  test('client -> client + all; server -> server + all', () => {
    expect(domains(['src/client/x.tsx'])).toEqual(['all', 'client'])
    expect(domains(['src/server/x.ts'])).toEqual(['all', 'server'])
  })
  test('shared -> client, server, shared, all', () => {
    expect(domains(['src/shared/x.ts'])).toEqual(['all', 'client', 'server', 'shared'])
  })
  test('tests and infrastructure -> every domain', () => {
    const every = ['all', 'client', 'docs', 'server', 'shared']
    for (const f of ['src/client/a.test.ts', 'package.json', 'vite.config.ts', 'scripts/anything.ts', 'bunfig.toml', 'src/testIsolation.setup.ts']) expect(domains([f])).toEqual(every)
  })
  test('docs and markdown -> docs only; unrelated files -> nothing', () => {
    expect(domains(['docs/testing.md', 'README.md'])).toEqual(['docs'])
    expect(domains(['assets/logo.png'])).toEqual([])
  })
})

describe('steps and logs', () => {
  const plan = buildPlan(['src/server/a.ts', 'src/server/a.real.bun.test.ts'], fixture(), { policy: false })

  test('bun steps pass an explicit file list with --no-env-file and a temp HOME; real suites keep the real HOME', () => {
    const steps = buildSteps(plan, '/repo', { typecheck: true, bunPath: 'bun' })
    expect(steps.map((s) => s.section)).toEqual(['typecheck', 'vitest', 'bun', 'bun'])
    const bun = steps.filter((s) => s.section === 'bun')
    expect(bun[0]!.args).toEqual(['test', '--no-env-file', ...plan.bun])
    expect(bun[0]!.env).toEqual({ HOME: '@tmp-home' })
    expect(bun[1]!.env).toEqual({})
  })

  test('large lists are chunked below the guard limit', () => {
    const many = { ...plan, vitestTests: Array.from({ length: 95 }, (_, i) => `src/client/f${i}.test.ts`), vitestGraph: [], vitestRelated: [], bun: [], bunReal: [] }
    const sizes = buildSteps(many, '/repo', { typecheck: false, bunPath: 'bun' }).map((s) => s.files.length)
    expect(sizes).toEqual([40, 40, 15])
  })

  test('nice wraps a command only when available', () => {
    expect(lowPriority('x', ['1'], true)).toEqual({ cmd: 'nice', args: ['-n', '15', 'x', '1'] })
    expect(lowPriority('x', ['1'], false)).toEqual({ cmd: 'x', args: ['1'] })
  })

  test('failed files come from vitest FAIL lines and bun (fail) lines', () => {
    const log = [' FAIL  src/client/a.test.ts > renders', 'src/server/b.bun.test.ts:', '(pass) ok', '(fail) breaks', 'src/server/c.bun.test.ts:', '(pass) fine'].join('\n')
    expect(failedFiles(log)).toEqual(['src/client/a.test.ts', 'src/server/b.bun.test.ts'])
  })

  test('options: --files collects paths until the next flag', () => {
    expect(parseOptions(['--dry', '--files', 'a.ts', 'b.ts', '--no-policy', '--base', 'main'])).toEqual({ dry: true, policy: false, typecheck: false, base: 'main', files: ['a.ts', 'b.ts'] })
    let message = ''
    try { parseOptions(['--nope']) } catch (e) { message = (e as Error).message }
    expect(message).toContain('unknown option')
  })
})
