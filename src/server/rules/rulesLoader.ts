// Project rules files with a scope, after Cursor rules (cursor.com/docs/context/rules: `.mdc` with
// frontmatter `description`, `globs`, `alwaysApply`) and AGENTS.md (agents.md: nearest file in the
// tree applies). Sources, in order:
//   .webterm/rules/*.md   webterm's own, loaded by webterm
//   .cursor/rules/*.mdc   Cursor's, loaded by webterm (Claude Code does not read them)
//   AGENTS.md (any dir)   loaded by webterm unless CLAUDE.md imports it (`@AGENTS.md`)
//   CLAUDE.md, .claude/rules/*.md  loaded by Claude Code itself; listed only, never re-injected
// Modes (Cursor's): always | auto (globs match a touched file) | agent (description only: listed so
// the agent can Read it when relevant) | manual (listed, never loaded).
import { readdirSync } from 'node:fs'
import { join, posix } from 'node:path'

declare const Bun: {
  YAML: { parse(text: string): unknown }
  Glob: new (pattern: string) => { match(path: string): boolean }
}

export type RuleMode = 'always' | 'auto' | 'agent' | 'manual'
export type RuleSource = 'webterm' | 'cursor' | 'agents-md' | 'claude-md' | 'claude-rules'

export interface RuleFile {
  path: string
  source: RuleSource
  mode: RuleMode
  description: string
  globs: string[]
  /** Who puts it in the session: webterm (hook context) or Claude Code (its own memory loader). */
  loadedBy: 'webterm' | 'claude-code'
  body: string
  chars: number
  /** Frontmatter that did not parse; the file is then treated as having none. */
  error?: string
}

export const RULE_MAX_BYTES = 64 * 1024
/** Budget of the rules block webterm injects (Claude Code caps `additionalContext` at 10k). */
export const RULES_BLOCK_MAX_CHARS = 4000
const RULE_DIRS: Array<{ dir: string; ext: RegExp; source: RuleSource }> = [
  { dir: '.webterm/rules', ext: /\.mdc?$/, source: 'webterm' },
  { dir: '.cursor/rules', ext: /\.mdc?$/, source: 'cursor' },
  { dir: '.claude/rules', ext: /\.md$/, source: 'claude-rules' },
]

interface Front { meta: Record<string, unknown>; body: string; error?: string }

/** Pure. Splits `---` YAML frontmatter from the body. */
export function parseFrontmatter(text: string): Front {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)
  if (!m) return { meta: {}, body: text }
  try {
    const meta = Bun.YAML.parse(m[1] ?? '')
    return { meta: meta && typeof meta === 'object' && !Array.isArray(meta) ? meta as Record<string, unknown> : {}, body: text.slice(m[0].length) }
  } catch (err) {
    return { meta: {}, body: text.slice(m[0].length), error: `frontmatter: ${err instanceof Error ? err.message : String(err)}` }
  }
}

/** Cursor writes `globs: src/**, *.ts` as one comma string; YAML lists work too. */
function globList(v: unknown): string[] {
  const raw = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : []
  return raw.filter((g): g is string => typeof g === 'string').map((g) => g.trim()).filter(Boolean)
}

/** Pure. True when repo-relative `path` matches `glob`; a slash-free glob matches at any depth (gitignore style). */
export function globMatches(glob: string, path: string): boolean {
  const g = glob.replace(/^\.?\//, '')
  return new Bun.Glob(g.includes('/') ? g : `**/${g}`).match(path)
}

function ruleOf(path: string, source: RuleSource, text: string, claudeImportsAgents: boolean): RuleFile {
  const { meta, body, error } = parseFrontmatter(text)
  const dir = posix.dirname(path)
  const nested = dir !== '.' && (source === 'agents-md' || source === 'claude-md')
  const globs = nested ? [`${dir}/**`] : globList(meta.globs ?? meta.paths)
  const description = typeof meta.description === 'string' ? meta.description.trim() : ''
  const always = meta.alwaysApply === true || (!nested && (source === 'agents-md' || source === 'claude-md'))
    // A .webterm / .claude rule without frontmatter applies everywhere; a bare Cursor rule is manual.
    || (globs.length === 0 && !description && (source === 'webterm' || source === 'claude-rules'))
  const mode: RuleMode = always ? 'always' : globs.length ? 'auto' : description ? 'agent' : 'manual'
  const loadedBy = source === 'claude-md' || source === 'claude-rules' || (source === 'agents-md' && claudeImportsAgents) ? 'claude-code' : 'webterm'
  return { path, source, mode, description, globs, loadedBy, body: body.trim(), chars: body.trim().length, ...(error ? { error } : {}) }
}

function listDir(root: string, dir: string): string[] {
  try { return readdirSync(join(root, dir)).sort().map((n) => `${dir}/${n}`) } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'ENOTDIR') return []
    throw new Error(`rules: listing ${dir} failed: ${(err as Error).message}`)
  }
}

/** Every rules file of the project at `root`, in source order. Nested AGENTS.md/CLAUDE.md need git. */
export async function discoverRules(root: string): Promise<RuleFile[]> {
  // Lazy: knowledgeScan pulls bun:sqlite, and the hook path that imports this module is loaded by vitest.
  const { listFiles, readTextSafe } = await import('../knowledge/knowledgeScan')
  const found: Array<{ path: string; source: RuleSource }> = []
  for (const d of RULE_DIRS) for (const p of listDir(root, d.dir)) if (d.ext.test(p)) found.push({ path: p, source: d.source })
  const listed = (await listFiles(root))?.map((f) => f.path) ?? ['AGENTS.md', 'CLAUDE.md']
  for (const p of [...listed].sort()) {
    const name = posix.basename(p)
    if (name === 'AGENTS.md') found.push({ path: p, source: 'agents-md' })
    else if (name === 'CLAUDE.md') found.push({ path: p, source: 'claude-md' })
  }
  const texts = new Map(found.map((f) => [f.path, readTextSafe(root, f.path, RULE_MAX_BYTES)]))
  const imports = /(^|\s)@\.?\/?AGENTS\.md\b/m.test(texts.get('CLAUDE.md') ?? '')
  return found.filter((f) => texts.get(f.path) != null).map((f) => ruleOf(f.path, f.source, texts.get(f.path) as string, imports))
}

/** Pure. Whether a rule is in force for a session that touched `touched` (repo-relative paths). */
export function ruleActive(rule: RuleFile, touched: readonly string[]): boolean {
  return rule.mode === 'always' || (rule.mode === 'auto' && touched.some((t) => rule.globs.some((g) => globMatches(g, t))))
}

export interface RulesBlock { text: string; included: string[]; listed: string[] }

/**
 * Pure. The text webterm adds to the agent's context: bodies of the active webterm-loaded rules, then
 * an index of description-only rules. Claude Code's own files are skipped (it already loaded them).
 */
export function rulesBlock(rules: readonly RuleFile[], touched: readonly string[], maxChars = RULES_BLOCK_MAX_CHARS): RulesBlock {
  const ours = rules.filter((r) => r.loadedBy === 'webterm')
  const parts: string[] = []
  const included: string[] = []
  let used = 0
  for (const r of ours.filter((x) => ruleActive(x, touched))) {
    const head = `Project rule ${r.path}${r.mode === 'auto' ? ` (applies to ${r.globs.join(', ')})` : ''}:`
    const part = `${head}\n${r.body}`
    if (used + part.length > maxChars) continue
    parts.push(part); included.push(r.path); used += part.length + 2
  }
  const agent = ours.filter((r) => r.mode === 'agent')
  const index = agent.map((r) => `- ${r.path}: ${r.description}`)
  const listed: string[] = []
  if (index.length) {
    const head = 'More project rules (Read the file when its description fits the task):'
    let block = head
    for (const [i, line] of index.entries()) {
      if (used + block.length + line.length + 1 > maxChars) break
      block += `\n${line}`; listed.push(agent[i]?.path as string)
    }
    if (listed.length) parts.push(block)
  }
  return { text: parts.join('\n\n'), included, listed }
}
