// unreferenced_module: a regex import graph over the scanned JS/TS files. A module nobody imports
// (or only tests import) is reported with confidence `medium`, never `high`: dynamic entry points
// (a path built at runtime, a loader config the scan does not read) can escape the graph. Pure.
import type { FindingDraft } from '../../../shared/centralHealth'
import { findingFingerprint } from './healthFingerprint'
import { extOf, isTestFile } from './healthRules.size'

/** Rule citation for unreferenced-module findings (dead code). */
export const UNREFERENCED_SOURCE = 'Rule 17 (global CLAUDE.md)'
/** Extensions that join the import graph. */
export const GRAPH_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'])
const PROBE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.mts', '.cjs', '.d.ts']
const JS_TO_TS: Record<string, string[]> = { '.js': ['.ts', '.tsx'], '.jsx': ['.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'] }

const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+|\bnew\s+URL\s*\(\s*)(['"`])([^'"`\n]+)\1/g
/** `<script src>` / `<link href>` style references in html. */
const HTML_SRC = /\b(?:src|href)\s*=\s*(['"])([^'"\n]+)\1/g
/** Test-support modules (fakes, fixtures, harnesses, kits): importing them only from tests is the point. */
const TEST_SUPPORT = /\.(fake|fixtures?|harness|testkit|testutil|mock|scripted)s?[A-Z.][^/]*$|(^|\/)(fake|mock)[A-Z][^/]*$|(Harness|TestKit|Fixtures?|Fake)\.[^/]+$|(^|\/)(test-?setup|setupTests)\.[^/]+$/
/** Manifests/configs whose plain text naming a path makes it an entry point (scripts, bin, include). */
const MANIFEST = /(^|\/)(package\.json|tsconfig[^/]*\.json|jsconfig[^/]*\.json|bunfig\.toml|[^/]+\.config\.[^/]+|[^/]+\.html?)$/
/** Paths that are entry points by convention. */
const ENTRY = [
  /(^|\/)[^/]*\.config\.[^/]+$/,
  /\.d\.[mc]?ts$/,
  /^(?:src\/)?(?:[^/]+\/)?index\.[^/]+$/,
  /(^|\/)public\//, // static assets served as-is
  /(^|\/)(__)?fixtures?(__)?\//, // fixture files are loaded or spawned by tests, not imported
]

/** Directory part of a posix path ('' at the root). */
function dirOf(path: string): string {
  const at = path.lastIndexOf('/')
  return at < 0 ? '' : path.slice(0, at)
}

/** Joins and normalizes posix segments (`..`, `.`); null when it climbs above the root. */
function joinPosix(base: string, rel: string): string | null {
  const parts: string[] = []
  for (const seg of `${base}/${rel}`.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') { if (parts.length === 0) return null; parts.pop() } else parts.push(seg)
  }
  return parts.join('/')
}

/** `compilerOptions.paths` aliases from a root tsconfig.json (`"@/*": ["./src/client/*"]`). */
export function tsconfigAliases(text: string | undefined): { prefix: string; target: string }[] {
  if (!text) return []
  let parsed: unknown
  try {
    // tsconfig allows comments and trailing commas; strip the common forms before JSON.parse.
    parsed = JSON.parse(text.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/,(\s*[}\]])/g, '$1'))
  } catch {
    return [] // unparseable tsconfig: only alias resolution is lost; findings stay confidence medium
  }
  const opts = (parsed as { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } })?.compilerOptions
  const base = opts?.baseUrl ?? '.'
  return Object.entries(opts?.paths ?? {}).flatMap(([key, targets]) => {
    const target = Array.isArray(targets) ? targets[0] : undefined
    if (typeof target !== 'string') return []
    const resolved = joinPosix(base, target.replace(/\*$/, ''))
    return resolved === null ? [] : [{ prefix: key.replace(/\*$/, ''), target: resolved }]
  })
}

/** Resolves one specifier from `from` to a scanned file, or null (bare package / missing). */
export function resolveSpecifier(from: string, spec: string, files: ReadonlySet<string>, aliases: { prefix: string; target: string }[] = []): string | null {
  let base: string | null = null
  if (spec.startsWith('/')) base = joinPosix('', spec.split(/[?#]/)[0] as string)
  else if (spec.startsWith('.')) base = joinPosix(dirOf(from), spec.split(/[?#]/)[0] as string)
  else {
    const alias = aliases.find((a) => a.prefix !== '' && spec.startsWith(a.prefix))
    if (alias) base = joinPosix(alias.target, spec.slice(alias.prefix.length))
  }
  if (base === null) return null
  if (files.has(base)) return base
  const ext = extOf(base)
  for (const ts of JS_TO_TS[ext] ?? []) {
    const swapped = base.slice(0, -ext.length) + ts
    if (files.has(swapped)) return swapped
  }
  for (const e of PROBE_EXTENSIONS) if (files.has(base + e)) return base + e
  for (const e of PROBE_EXTENSIONS) if (files.has(`${base}/index${e}`)) return `${base}/index${e}`
  return null
}

/** Escapes a string for literal use inside a RegExp. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** True when another file names `path` as a string literal, or a manifest/config/html names it at all. */
function mentioned(path: string, texts: ReadonlyMap<string, string>): boolean {
  const ext = extOf(path)
  const stem = escapeRe(ext ? path.slice(0, -ext.length) : path)
  const literal = new RegExp(`["'\`](?:\\.?/)?${stem}(?:\\.[\\w]+)?["'\`]`)
  for (const [other, text] of texts) {
    if (other === path) continue
    if (MANIFEST.test(other) ? text.includes(path) : literal.test(text)) return true
  }
  return false
}

/** unreferenced_module findings over every scanned file (`texts`: repo path → text). */
export function unreferencedFindings(texts: ReadonlyMap<string, string>): FindingDraft[] {
  const files = new Set(texts.keys())
  const aliases = tsconfigAliases(texts.get('tsconfig.json'))
  const importers = new Map<string, Set<string>>()
  for (const [from, text] of texts) {
    const html = /\.html?$/.test(from)
    if (!GRAPH_EXTENSIONS.has(extOf(from)) && !html && !/\.(vue|svelte)$/.test(from)) continue
    for (const m of text.matchAll(html ? HTML_SRC : SPECIFIER)) {
      const target = resolveSpecifier(from, m[2] as string, files, aliases)
      if (target === null || target === from) continue
      const set = importers.get(target) ?? new Set<string>()
      set.add(from)
      importers.set(target, set)
    }
  }
  const graphFiles = [...files].filter((f) => GRAPH_EXTENSIONS.has(extOf(f)))
  const found: FindingDraft[] = []
  for (const file of graphFiles) {
    if (isTestFile(file) || ENTRY.some((re) => re.test(file))) continue
    const support = TEST_SUPPORT.test(file)
    const by = [...(importers.get(file) ?? [])]
    const onlyTests = by.length > 0 && by.every((f) => isTestFile(f) || TEST_SUPPORT.test(f))
    if (by.length > 0 && (!onlyTests || support)) continue
    if (mentioned(file, texts)) continue
    found.push({
      rule: 'unreferenced_module', severity: 'low', confidence: 'medium', file, line: null,
      title: onlyTests ? 'Module is only imported by tests' : 'Module is not imported anywhere',
      evidence: onlyTests
        ? `only test files import this module (${by.length} importer${by.length === 1 ? '' : 's'}; checked ${graphFiles.length} files)`
        : `no file imports this module (checked ${graphFiles.length} files)`,
      source: UNREFERENCED_SOURCE,
      suggestion: onlyTests
        ? 'Wire the module into the product or delete it together with its tests.'
        : 'Delete the module if it is dead code; if it is a dynamic entry point, ignore this finding.',
      fingerprint: findingFingerprint('unreferenced_module', file),
    })
  }
  return found
}
