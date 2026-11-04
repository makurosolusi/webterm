// Repo-map ranking, after Aider `get_ranked_tags` (aider/repomap.py): a file graph where an edge
// referencer -> definer carries every identifier the first uses and the second defines, weighted the
// way Aider weights it; personalized PageRank over it; then the rank flowing along each edge is
// credited to the (definer, identifier) pair so each file lists its most-used symbols first.
import { estimateTokens } from '../central/tools/toolRegistry'
import type { FileSymbols, SymbolDef } from './repoMapSymbols'

export const REPO_MAP_DEFAULT_TOKENS = 1024 // Aider `--map-tokens` default
export const REPO_MAP_MAX_TOKENS = 8192
const DAMPING = 0.85
const ITERATIONS = 40
const SYMBOLS_PER_FILE = 8

export interface RankedFile { path: string; rank: number; symbols: SymbolDef[] }

/** Aider's identifier multiplier: long compound names matter, private and over-defined ones do not. */
function identWeight(ident: string, definers: number): number {
  let mul = 1
  const compound = /_/.test(ident) || /[a-z][A-Z]/.test(ident)
  if (compound && ident.length >= 8) mul *= 10
  if (ident.startsWith('_')) mul *= 0.1
  if (definers > 5) mul *= 0.1
  return mul
}

/** Pure. Files ranked by personalized PageRank; `focus` paths (opened/touched) bias the walk. */
export function rankFiles(files: ReadonlyMap<string, FileSymbols>, focus: readonly string[] = []): RankedFile[] {
  const paths = [...files.keys()].sort()
  const idx = new Map(paths.map((p, i) => [p, i]))
  const definers = new Map<string, number[]>()
  for (const [path, s] of files) for (const d of s.defs) {
    const list = definers.get(d.name) ?? []
    const i = idx.get(path) as number
    if (!list.includes(i)) list.push(i)
    definers.set(d.name, list)
  }
  const focusSet = new Set(focus.filter((f) => idx.has(f)).map((f) => idx.get(f) as number))
  const edges: Array<{ src: number; dst: number; ident: string; w: number }> = []
  const out = new Float64Array(paths.length)
  for (const [path, s] of files) {
    const src = idx.get(path) as number
    for (const [ident, count] of Object.entries(s.refs)) {
      const defs = definers.get(ident)
      if (!defs) continue
      const w = identWeight(ident, defs.length) * Math.sqrt(count) * (focusSet.has(src) ? 50 : 1)
      for (const dst of defs) if (dst !== src) { edges.push({ src, dst, ident, w }); out[src] += w }
    }
  }
  const n = paths.length
  const p = new Float64Array(n).fill(focusSet.size ? 0 : 1 / Math.max(n, 1))
  for (const f of focusSet) p[f] = 1 / focusSet.size
  let rank = Float64Array.from(p)
  for (let it = 0; it < ITERATIONS; it++) {
    const next = new Float64Array(n)
    let dangling = 0
    for (let i = 0; i < n; i++) if (out[i] === 0) dangling += rank[i] as number
    for (const e of edges) next[e.dst] += DAMPING * (rank[e.src] as number) * e.w / (out[e.src] as number)
    for (let i = 0; i < n; i++) next[i] += (1 - DAMPING + DAMPING * dangling) * (p[i] as number)
    rank = next
  }
  const symRank = new Map<string, number>()
  for (const e of edges) {
    const key = `${e.dst}\0${e.ident}`
    symRank.set(key, (symRank.get(key) ?? 0) + (rank[e.src] as number) * e.w / (out[e.src] as number))
  }
  return paths.map((path, i) => {
    const defs = files.get(path)?.defs ?? []
    const score = (d: SymbolDef): number => symRank.get(`${i}\0${d.name}`) ?? 0
    const symbols = [...defs].sort((a, b) => score(b) - score(a) || a.line - b.line).slice(0, SYMBOLS_PER_FILE)
    return { path, rank: rank[i] as number, symbols }
  }).filter((f) => f.symbols.length > 0).sort((a, b) => b.rank - a.rank || a.path.localeCompare(b.path))
}

export interface RenderedMap { text: string; files: number; totalFiles: number; truncated: boolean; tokens: number }

/** Pure. The ranked map as text, whole files only, within `maxTokens`. */
export function renderMap(ranked: readonly RankedFile[], maxTokens = REPO_MAP_DEFAULT_TOKENS): RenderedMap {
  const budget = Math.min(Math.max(maxTokens, 1), REPO_MAP_MAX_TOKENS)
  let text = ''
  let files = 0
  for (const f of ranked) {
    const block = `${f.path}:\n${f.symbols.map((s) => `  ${s.line}: ${s.kind} ${s.name}`).join('\n')}\n`
    if (estimateTokens(text + block) > budget) break
    text += block
    files++
  }
  return { text, files, totalFiles: ranked.length, truncated: files < ranked.length, tokens: estimateTokens(text) }
}
