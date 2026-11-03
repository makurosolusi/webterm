// Pencocokan fuzzy Quick Open (WS-FM-09): subsequence case-insensitive tanpa dependency.
const SCORE = { char: 1, run: 5, segmentStart: 8, inName: 3, nameOnly: 50, lengthPenalty: 0.01 }
const SEGMENT_BREAK = new Set(['/', '.', '-', '_', ' '])

/** Skor `q` terhadap `s` (greedy kiri-ke-kanan), atau `null` bila bukan subsequence. */
function scoreIn(q: string, s: string, nameStart: number): number | null {
  let score = 0
  let at = -1
  for (const ch of q) {
    const next = s.indexOf(ch, at + 1)
    if (next < 0) return null
    score += SCORE.char
    if (next === at + 1 && at >= 0) score += SCORE.run
    if (next === 0 || SEGMENT_BREAK.has(s[next - 1])) score += SCORE.segmentStart
    if (next >= nameStart) score += SCORE.inName
    at = next
  }
  return score - s.length * SCORE.lengthPenalty
}

/** Skor kecocokan `path` untuk `query` (lebih besar = lebih baik); `null` = tidak cocok. Cocok di nama file dihargai lebih. */
export function fuzzyScore(query: string, path: string): number | null {
  const q = query.toLowerCase()
  const p = path.toLowerCase()
  if (!q) return 0
  const nameStart = p.lastIndexOf('/') + 1
  const inName = scoreIn(q, p.slice(nameStart), 0)
  if (inName !== null) return inName + SCORE.nameOnly
  return scoreIn(q, p, nameStart)
}

/** Path yang cocok, skor tertinggi dulu (urutan input menjadi pemutus seri), maksimal `limit`. Query kosong = urutan input. */
export function fuzzyFilter(query: string, paths: readonly string[], limit: number): string[] {
  if (!query) return paths.slice(0, limit)
  const scored: Array<{ path: string; score: number }> = []
  for (const path of paths) {
    const score = fuzzyScore(query, path)
    if (score !== null) scored.push({ path, score })
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((s) => s.path)
}
