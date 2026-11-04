// Symbol extraction for the repo-map (Aider repomap, aider.chat/docs/repomap.html): per file, the
// names it DEFINES and the identifiers it REFERENCES. Aider gets both from tree-sitter tag queries;
// no tree-sitter binding is installed here, so this is a regex "ctags-lite" per language.
// ponytail: top-level definitions only (no class methods / nested funcs); add tree-sitter when a
// language needs member-level symbols.

/** One definition: name, 1-based line, keyword (`function`, `class`, `def`, `type`, ...). */
export interface SymbolDef { name: string; line: number; kind: string }
export interface FileSymbols { defs: SymbolDef[]; refs: Record<string, number> }
export type RepoLang = 'ts' | 'py' | 'go'

/** Distinct identifiers kept per file; the rest are dropped (a generated file must not blow up the cache). */
export const MAX_REFS_PER_FILE = 2000
const MAX_DEFS_PER_FILE = 300

const EXT: Record<string, RepoLang> = { ts: 'ts', tsx: 'ts', mts: 'ts', cts: 'ts', js: 'ts', jsx: 'ts', mjs: 'ts', cjs: 'ts', py: 'py', go: 'go' }

const DEF_RULES: Record<RepoLang, Array<{ re: RegExp; kind?: string }>> = {
  ts: [{ re: /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(function\*?|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/ }],
  py: [{ re: /^(?: {0,4})(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)/ }, { re: /^()([A-Z][A-Z0-9_]+)\s*(?::[^=]*)?=/, kind: 'const' }],
  go: [{ re: /^(func)\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/ }, { re: /^(type|const|var)\s+([A-Za-z_]\w*)/ }],
}

/** Language of a repo-relative path, or null when the repo-map does not read it. */
export function repoLangOf(path: string): RepoLang | null {
  const dot = path.lastIndexOf('.')
  return dot < 0 ? null : EXT[path.slice(dot + 1).toLowerCase()] ?? null
}

/** Pure. Definitions and identifier reference counts of one source text. */
export function extractSymbols(text: string, lang: RepoLang): FileSymbols {
  const defs: SymbolDef[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length && defs.length < MAX_DEFS_PER_FILE; i++) {
    for (const rule of DEF_RULES[lang]) {
      const m = rule.re.exec(lines[i] ?? '')
      if (m?.[2]) { defs.push({ name: m[2], line: i + 1, kind: rule.kind ?? (m[1] || 'def').replace('*', '') }); break }
    }
  }
  const refs: Record<string, number> = {}
  let distinct = 0
  for (const m of text.matchAll(/[A-Za-z_$][\w$]*/g)) {
    const id = m[0]
    if (refs[id] !== undefined) refs[id] += 1
    else if (distinct < MAX_REFS_PER_FILE) { refs[id] = 1; distinct++ }
  }
  // A file's own definitions are not references to itself (each name is counted once at its def site).
  for (const d of defs) if (refs[d.name] !== undefined && --refs[d.name] <= 0) delete refs[d.name]
  return { defs, refs }
}
