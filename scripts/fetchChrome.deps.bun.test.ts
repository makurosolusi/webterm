// Guards the Dockerfile: the image runs `bun scripts/fetch-chrome.ts` before the app source is copied, so every
// src/ file that script reaches through relative imports must be named in an early `COPY src/...` line.
import { expect, test } from 'bun:test'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const ENTRY = 'scripts/fetch-chrome.ts'
// Runtime imports only: `import type` is erased by Bun. Matches `import x from '.'`, `export ... from '.'`, `import('.')`.
const REL_IMPORT = /(?:^|\n)\s*(?:import(?!\s+type\b)[^'"\n]*?from\s*|export\s[^'"\n]*?from\s*|import\s*\(\s*|import\s+)['"](\.{1,2}\/[^'"]+)['"]/g

function resolveSource(from: string, spec: string): string | null {
  const base = resolve(ROOT, dirname(from), spec)
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    if (existsSync(cand) && statSync(cand).isFile()) return relative(ROOT, cand)
  }
  return null
}

function closure(entry: string): string[] {
  const seen = new Set<string>([entry])
  const queue = [entry]
  while (queue.length > 0) {
    const file = queue.pop() as string
    const text = readFileSync(join(ROOT, file), 'utf8')
    for (const m of text.matchAll(REL_IMPORT)) {
      const next = resolveSource(file, m[1] as string)
      if (next === null) throw new Error(`${file} imports '${m[1]}' which does not resolve to a source file`)
      if (!seen.has(next)) { seen.add(next); queue.push(next) }
    }
  }
  return [...seen]
}

/** Files named by `COPY <srcs...> <dest>` lines whose sources live under src/ (dest dir expanded per source). */
function copiedFromSrc(dockerfile: string): Set<string> {
  const copied = new Set<string>()
  for (const line of dockerfile.split('\n')) {
    const m = /^COPY\s+(?!--)(.+)$/.exec(line.trim())
    if (m === null) continue
    const parts = (m[1] as string).split(/\s+/)
    for (const src of parts.slice(0, -1)) if (src.startsWith('src/')) copied.add(src)
  }
  return copied
}

test('every src/ file reached by scripts/fetch-chrome.ts is copied before the Chrome fetch', () => {
  const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8')
  const fetchAt = dockerfile.indexOf('$(bun scripts/fetch-chrome.ts')
  expect(fetchAt).toBeGreaterThan(-1)
  const copied = copiedFromSrc(dockerfile.slice(0, fetchAt))
  const needed = closure(ENTRY).filter((f) => f.startsWith('src/'))
  expect(needed.length).toBeGreaterThan(3)
  const missing = needed.filter((f) => !copied.has(f))
  expect(missing).toEqual([])
})
