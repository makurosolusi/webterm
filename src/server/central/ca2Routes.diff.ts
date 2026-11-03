// Line diff of a skill draft against the version that is active now (WS-19 review panel).
// Skill files are capped at a few KB, so a plain LCS table is cheap; larger inputs degrade to "all added".
const MAX_LINES = 400

/** `+`/`-`/two-space prefixed lines turning `before` into `after`. */
export function lineDiff(before: string, after: string): string {
  const a = before === '' ? [] : before.split('\n')
  const b = after === '' ? [] : after.split('\n')
  if (a.length > MAX_LINES || b.length > MAX_LINES) return b.map((l) => `+ ${l}`).join('\n')
  // lcs[i][j] = longest common subsequence of a[i..] and b[j..].
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
  }
  const out: string[] = []
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { out.push(`  ${a[i]}`); i++; j++ }
    else if (j < b.length && (i === a.length || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) out.push(`+ ${b[j++]}`)
    else out.push(`- ${a[i++]}`)
  }
  return out.join('\n')
}
