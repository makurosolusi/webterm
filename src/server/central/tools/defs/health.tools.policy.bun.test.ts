// Central only advises on health: no registered tool can dismiss, reopen or "fix" a finding; that is the human's call.
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'bun:test'
import { registerCa2Tools } from '../registerAll'
import { createRegistry } from '../toolRegistry'
import { CORE_DEFS } from './core.defs'

const stub = {} as never // test-only: builders capture deps, they never call them at registration
const env = new Proxy({} as Record<string, string>, { get: (_t, k: string) => (k === 'WEBTERM_CENTRAL_AGENTS' ? 'auto' : 'on') })
const dir = dirname(fileURLToPath(import.meta.url))
const toolsDir = join(dir, '..')

function everyName(): string[] {
  const registry = createRegistry()
  for (const def of CORE_DEFS) registry.register(def)
  registerCa2Tools(registry, { executor: stub, deliver: stub, openKb: stub, skills: stub, userStore: stub, bots: stub, browser: stub }, env)
  return registry.list().map((d) => d.name)
}

/** Tool sources: every non-test file under tools/ plus the out-of-tree def files registerAll imports. */
function toolSources(): string[] {
  const local = [toolsDir, dir].flatMap((d) => readdirSync(d).filter((f) => f.endsWith('.ts') && !f.includes('.test.')).map((f) => join(d, f)))
  const imported = [...readFileSync(join(toolsDir, 'registerAll.ts'), 'utf8').matchAll(/from '(\.\.\/\.\.\/[^']+)'/g)].map((m) => join(toolsDir, `${m[1]}.ts`))
  return [...local, ...imported]
}

test('the registered health tools are exactly the read and scan ones', () => {
  const names = everyName()
  expect(names.filter((n) => n.startsWith('health.')).sort()).toEqual(['health.findings', 'health.scan', 'health.summary'])
  expect(names.filter((n) => /(dismiss|reopen|fix)/i.test(n) && /health|finding/i.test(n))).toEqual([])
})

test('no tool code changes a finding status', () => {
  const sources = toolSources()
  expect(sources.some((f) => f.endsWith('health.defs.ts'))).toBe(true)
  const writes = (text: string): boolean => /\.(dismiss|reopen)\(/.test(text) || /UPDATE\s+central_finding/i.test(text)
  // The detector sees the one human surface that does write: the board route.
  expect(writes(readFileSync(join(toolsDir, '..', 'ca2Routes.health.ts'), 'utf8'))).toBe(true)
  const writers = sources.filter((f) => writes(readFileSync(f, 'utf8')))
  expect(writers).toEqual([])
})
