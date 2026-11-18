// Static reverse import graph for `test:impacted`. bun has no `related` mode, so this finds the
// *.bun.test.ts files that (transitively) import a changed file. Pure: callers pass the file list and a reader.
import { posix } from 'node:path'

const IMPORT_RE = /(?:\bfrom|\bimport\s*\(|\brequire\s*\(|\bimport)\s*['"](\.{1,2}\/[^'"]+)['"]/g
/** A quoted relative-looking source path, e.g. `join(import.meta.dirname, 'index.ts')` in a test that spawns an entry. */
const SOURCE_PATH_RE = /['"]((?:\.{1,2}\/)*[\w.-]+(?:\/[\w.-]+)*\.tsx?)['"]/g
const EXTENSIONS = ['', '.ts', '.tsx', '/index.ts', '/index.tsx']

/** Relative import specifiers in `text` (`./x`, `../y/z`); bare package names are ignored. */
export function importSpecifiers(text: string): string[] {
  return [...text.matchAll(IMPORT_RE)].map((m) => m[1]!)
}

/** Repo-relative file a relative specifier points at, or null when it is not in `known`. */
export function resolveImport(from: string, spec: string, known: Set<string>): string | null {
  const base = posix.normalize(posix.join(posix.dirname(from), spec))
  const stripped = base.replace(/\.(m?js)$/, '')
  for (const stem of new Set([base, stripped])) {
    for (const ext of EXTENSIONS) if (known.has(stem + ext)) return stem + ext
  }
  return null
}

/** file -> files that import it (or name it as a quoted path, which covers entries a test spawns). */
export function buildReverseGraph(files: string[], read: (file: string) => string): Map<string, Set<string>> {
  const known = new Set(files)
  const reverse = new Map<string, Set<string>>()
  const link = (to: string, from: string): void => {
    if (to === from) return
    if (!reverse.has(to)) reverse.set(to, new Set())
    reverse.get(to)!.add(from)
  }
  for (const f of files) {
    if (!/\.(tsx?|mjs|js)$/.test(f)) continue
    const text = read(f)
    for (const spec of importSpecifiers(text)) {
      const to = resolveImport(f, spec, known)
      if (to) link(to, f)
    }
    if (!f.endsWith('.test.ts') && !f.endsWith('.test.tsx')) continue
    for (const m of text.matchAll(SOURCE_PATH_RE)) {
      const to = resolveImport(f, m[1]!.startsWith('.') ? m[1]! : `./${m[1]!}`, known)
      if (to) link(to, f)
    }
  }
  return reverse
}

/** Every file that transitively imports any of `changed` (the changed files themselves excluded). */
export function dependentsOf(changed: string[], reverse: Map<string, Set<string>>): Set<string> {
  const seen = new Set<string>()
  const queue = [...changed]
  while (queue.length) {
    for (const dep of reverse.get(queue.pop()!) ?? []) {
      if (seen.has(dep)) continue
      seen.add(dep)
      queue.push(dep)
    }
  }
  for (const c of changed) seen.delete(c)
  return seen
}
