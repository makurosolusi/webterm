// Palette targets: node → row conversion and the ranking the omnibox and VS Code quick picks share.
// Targets for the canvas palette.

export interface PaletteTarget {
  id: string
  label: string
  /** Metadata kanan yang IKUT dicari (tipe node). */
  hint?: string
}

/** Bentuk node React Flow yang dibutuhkan palette — longgar supaya `Node[]` bisa lewat tanpa cast. */
export interface CanvasNodeLike {
  id: string
  type?: string
  data?: Record<string, unknown>
}

const text = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined

/** Cocok subsequence case-insensitive — "ntr" cocok dengan "New TeRminal". */
export function subsequenceMatch(haystack: string, q: string): boolean {
  if (!q) return true
  const s = haystack.toLowerCase()
  let i = 0
  for (const ch of q.toLowerCase()) {
    i = s.indexOf(ch, i)
    if (i === -1) return false
    i++
  }
  return true
}

const isWordStart = (s: string, i: number): boolean => i === 0 || /[^\p{L}\p{N}]/u.test(s[i - 1])

/**
 * Lebih kecil = lebih baik; `null` = tidak cocok. Tier, terbaik dulu: substring label di awal kata,
 * substring label di mana pun, substring hint, subsequence label, subsequence label+hint.
 * Ranking HARUS sebelum cap: tanpa ini query pendek mengisi daftar dengan baris yang cuma
 * kebetulan punya huruf-hurufnya, dan node yang benar-benar berjudul itu terpotong.
 */
export function targetScore(t: PaletteTarget, q: string): number | null {
  const query = q.trim().toLowerCase()
  if (!query) return 0
  const label = t.label.toLowerCase()
  let at = label.indexOf(query)
  while (at !== -1) {
    if (isWordStart(label, at)) return 0
    at = label.indexOf(query, at + 1)
  }
  if (label.includes(query)) return 1
  if ((t.hint ?? '').toLowerCase().includes(query)) return 2
  if (subsequenceMatch(t.label, query)) return 3
  if (subsequenceMatch(`${t.label} ${t.hint ?? ''}`, query)) return 4
  return null
}

/** Target yang cocok, terbaik dulu, dibatasi `limit`. Urutan deklarasi dipertahankan dalam satu tier. */
export function rankTargets(targets: PaletteTarget[], q: string, limit: number): PaletteTarget[] {
  if (!q.trim()) return targets.slice(0, limit)
  const scored: { t: PaletteTarget; score: number; idx: number }[] = []
  targets.forEach((t, idx) => {
    const score = targetScore(t, q)
    if (score !== null) scored.push({ t, score, idx })
  })
  scored.sort((a, b) => a.score - b.score || a.idx - b.idx)
  return scored.slice(0, limit).map((r) => r.t)
}

/** Node canvas → baris palette. Node tanpa judul tetap dapat label yang bisa dibaca. */
export function nodeTargets(nodes: CanvasNodeLike[]): PaletteTarget[] {
  return nodes.map((n) => {
    const d = n.data ?? {}
    const kind = text(d.kind) ?? n.type ?? 'node'
    const label = text(d.title) ?? text(d.agentId) ?? `${kind} ${n.id.slice(0, 6)}`
    return { id: n.id, label, hint: kind }
  })
}
