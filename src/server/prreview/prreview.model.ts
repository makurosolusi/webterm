// PR review bot (F6, PLAN/04-buku-ide.md #83): the pure half. Prompt, findings parser, the diff's
// commentable lines and the GitHub review payload. No I/O (vitest-safe).
//
// Copied from Claude Code GitHub Actions (`anthropics/claude-code-action`, docs/solutions.md
// "Automatic PR Code Review"): the prompt header `REPO:` / `PR NUMBER:`, the four focus areas
// ("code quality and best practices, potential bugs or issues, security implications, performance
// considerations"), the note that the PR branch is already checked out in the working directory, and
// the split between inline comments for specific code issues and one top-level summary.
// webterm difference: the action lets Claude post (`gh pr comment`, the inline-comment MCP tool).
// Here Claude only has read tools and returns findings as JSON; webterm posts ONE review
// (POST /repos/{o}/{r}/pulls/{n}/reviews, event COMMENT, inline `comments[]` with path/line/side)
// and only after the human approves the draft in the Inbox.

export type Severity = 'high' | 'medium' | 'low'
export const SEVERITIES: readonly Severity[] = ['high', 'medium', 'low']

export interface Finding {
  file: string
  line: number
  severity: Severity
  summary: string
  /** The line is on the RIGHT side of the diff, so GitHub accepts it as an inline comment. */
  inline: boolean
}

/** What the Inbox gate carries (its args); the human may edit it before posting. */
export interface PrDraft {
  /** `<pr url>@<head sha>`: one draft per PR head, so a poll never reviews the same head twice. */
  key: string
  repo: string
  slug: string
  pr: number
  url: string
  title: string
  commitId: string
  summary: string
  findings: Finding[]
}

export interface ReviewComment { path: string; line: number; side: 'RIGHT'; body: string }
export interface ReviewPayload { commit_id: string; body: string; event: 'COMMENT'; comments: ReviewComment[] }

export const DIFF_PROMPT_MAX = 200_000
export const FINDINGS_MAX = 50
const SUMMARY_MAX = 2000
const SLUG_RE = /^(?!\.+\/)[\w.-]+\/(?!\.+$)[\w.-]+$/
const SHA_RE = /^[0-9a-f]{40}$/

export function reviewPrompt(pr: { slug: string; pr: number; title: string; baseRef: string }, diff: string): string {
  const cut = diff.length > DIFF_PROMPT_MAX
  return [
    `REPO: ${pr.slug}`,
    `PR NUMBER: ${pr.pr}`,
    `TITLE: ${pr.title}`,
    '',
    'Please review this pull request with a focus on:',
    '- Code quality and best practices',
    '- Potential bugs or issues',
    '- Security implications',
    '- Performance considerations',
    '',
    'Note: The PR branch is already checked out in the current working directory.',
    `The diff against ${pr.baseRef} is below${cut ? ` (cut at ${DIFF_PROMPT_MAX} characters; read the files for the rest)` : ''}.`,
    '',
    'You have read-only tools. Do not try to post anything: webterm shows your findings to the user, who decides what is posted.',
    'Answer with ONE ```json block holding an array of findings, then one short paragraph summing up the PR:',
    '[{"file": "src/a.ts", "line": 12, "severity": "high", "summary": "What is wrong and how to fix it"}]',
    '- file: path relative to the repo root; line: line number in the NEW version of the file, on a line this diff adds or keeps.',
    '- severity: high (bug, security, data loss), medium (likely problem), low (worth a look).',
    '- Only real issues. No praise, no style nits a linter would catch. An empty array is a fine answer.',
    '',
    '```diff',
    cut ? diff.slice(0, DIFF_PROMPT_MAX) : diff,
    '```',
  ].join('\n')
}

/** Lines of each file a review comment may sit on: added or context lines of the new side. */
export function commentableLines(diff: string): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>()
  let lines: Set<number> | null = null
  let next = 0
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git ')) { lines = null; continue }
    if (raw.startsWith('+++ ')) {
      const path = raw.slice(4).trim()
      lines = path === '/dev/null' ? null : new Set()
      if (lines) out.set(path.replace(/^b\//, ''), lines)
      continue
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
    if (hunk) { next = Number(hunk[1]); continue }
    if (!lines || next === 0 || raw.startsWith('---')) continue
    if (raw.startsWith('+') || raw.startsWith(' ')) lines.add(next++)
    // '-' lines exist only on the old side; '\ No newline' is not a line.
  }
  return out
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

function oneFinding(v: unknown, commentable: Map<string, Set<number>> | null): Finding | null {
  if (!isObj(v)) return null
  const file = typeof v.file === 'string' ? v.file.trim().replace(/^\.?\//, '') : ''
  const line = Number(v.line)
  const severity = SEVERITIES.includes(v.severity as Severity) ? (v.severity as Severity) : 'medium'
  const summary = typeof v.summary === 'string' ? v.summary.trim().slice(0, SUMMARY_MAX) : ''
  if (!file || file.includes('..') || !Number.isInteger(line) || line < 1 || !summary) return null
  const inline = commentable ? commentable.get(file)?.has(line) === true : v.inline === true
  return { file, line, severity, summary, inline }
}

/**
 * Findings from Claude's final text: the last ```json block (or the whole text when it is bare JSON).
 * Malformed entries are dropped, not fatal. `null` = no JSON array at all (the run failed to answer).
 */
export function parseFindings(text: string, diff: string): { findings: Finding[]; summary: string } | null {
  const blocks = [...text.matchAll(/```json\s*\n([\s\S]*?)```/g)]
  const last = blocks.at(-1)
  const raw = last ? last[1] : text.trim()
  let parsed: unknown
  try { parsed = JSON.parse(raw ?? '') } catch { return null }
  if (!Array.isArray(parsed)) return null
  const commentable = commentableLines(diff)
  const findings = parsed.map((f) => oneFinding(f, commentable)).filter((f): f is Finding => f !== null).slice(0, FINDINGS_MAX)
  const summary = last ? text.slice((last.index ?? 0) + last[0].length).trim().slice(0, SUMMARY_MAX) : ''
  return { findings, summary }
}

/** Validates an (possibly hand-edited) draft from the Inbox; a string is the reason it cannot post. */
export function parseDraft(v: unknown): PrDraft | string {
  if (!isObj(v)) return 'the draft is not an object'
  if (typeof v.slug !== 'string' || !SLUG_RE.test(v.slug)) return 'draft.slug must be owner/repo'
  if (!Number.isInteger(v.pr) || (v.pr as number) < 1) return 'draft.pr must be a PR number'
  if (typeof v.commitId !== 'string' || !SHA_RE.test(v.commitId)) return 'draft.commitId must be a commit sha'
  if (typeof v.repo !== 'string' || !v.repo.startsWith('/')) return 'draft.repo must be an absolute path'
  if (!Array.isArray(v.findings)) return 'draft.findings must be an array'
  const findings = v.findings.map((f) => oneFinding(f, null))
  if (findings.some((f) => f === null)) return 'every finding needs file, line and summary'
  return {
    key: String(v.key ?? ''), repo: v.repo, slug: v.slug, pr: v.pr as number, url: String(v.url ?? ''), title: String(v.title ?? ''),
    commitId: v.commitId, summary: typeof v.summary === 'string' ? v.summary.slice(0, SUMMARY_MAX) : '', findings: findings as Finding[],
  }
}

const findingLine = (f: Finding): string => `- \`${f.file}:${f.line}\` **${f.severity}**: ${f.summary}`

/** ONE review: inline comments for lines in the diff, the rest listed in the body (GitHub rejects them inline). */
export function reviewPayload(d: PrDraft): ReviewPayload {
  const outside = d.findings.filter((f) => !f.inline)
  const body = [
    d.summary || 'Automated review.',
    ...(outside.length ? ['', 'Findings outside the diff:', ...outside.map(findingLine)] : []),
    '', '_Drafted by Claude Code in webterm and approved by a human before posting._',
  ].join('\n')
  return {
    commit_id: d.commitId, body, event: 'COMMENT',
    comments: d.findings.filter((f) => f.inline).map((f) => ({ path: f.file, line: f.line, side: 'RIGHT', body: `**${f.severity}**: ${f.summary}` })),
  }
}

/** Inbox body: one line per finding, readable on Telegram too. */
export const draftBody = (d: PrDraft): string =>
  [d.url, d.summary, ...d.findings.map((f) => `${f.inline ? '' : '(outside diff) '}${f.file}:${f.line} [${f.severity}] ${f.summary}`)].filter(Boolean).join('\n')

/** `https://github.com/o/r/pull/12` -> `o/r`; null for anything else. */
export function slugOfPrUrl(url: string): string | null {
  const m = /^https:\/\/[^/]+\/([\w.-]+\/[\w.-]+)\/pull\/\d+$/.exec(url.trim())
  return m ? m[1]! : null
}
