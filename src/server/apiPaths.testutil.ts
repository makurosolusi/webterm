// Test-only: every `/api/...` path literal in the source tree (server routes, shared constants and
// the client that calls them), so the auth locks walk the real route table instead of a hand list a
// new route family would slip past. `${...}` and `:param` segments become `x`.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(import.meta.dirname, '..')
const SOURCE_DIRS = ['server', 'shared', 'client']
const NOT_SOURCE = /\.test\.tsx?$|\.testutil\.tsx?$|\.d\.ts$/
const API_LITERAL = /['"`](\/api\/[A-Za-z0-9_\-/.:${}]*)/g

/** Source files (relative to src/) and the normalized /api paths each one names. */
export function apiPathsByFile(): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const dir of SOURCE_DIRS) {
    for (const rel of readdirSync(join(SRC, dir), { recursive: true }) as string[]) {
      if (!/\.tsx?$/.test(rel) || NOT_SOURCE.test(rel)) continue
      const file = `${dir}/${rel}`
      const found = [...readFileSync(join(SRC, file), 'utf8').matchAll(API_LITERAL)].map((m) =>
        (m[1] as string).replace(/\$\{[^}]*\}?/g, 'x').replace(/:[A-Za-z]+/g, 'x').replace(/[{}$]/g, ''))
      if (found.length > 0) out.set(file, [...new Set(found)])
    }
  }
  return out
}

/** Every distinct path, sorted. */
export const allApiPaths = (): string[] => [...new Set([...apiPathsByFile().values()].flat())].sort()
