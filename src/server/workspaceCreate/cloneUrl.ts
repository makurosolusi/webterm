// Pure helpers for the clone flow, copied from nodeterm src/shared/clone-url.ts (expand, validate,
// derive name, parse progress) and narrowed to the schemes webterm allows. No node imports: the
// client dialog reuses them for its live preview, the server re-checks authoritatively.

export interface CloneProgress {
  phase: string
  percent: number
}

/** `owner/repo` GitHub shorthand -> HTTPS clone URL. Anything else passes through trimmed (nodeterm). */
export function expandCloneUrl(input: string): string {
  const s = input.trim()
  const m = s.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/)
  if (m && !s.startsWith('-') && !s.startsWith('.')) return `https://github.com/${m[1]}/${m[2].replace(/\.git$/i, '')}.git`
  return s
}

/**
 * https://, ssh:// and scp-style `git@host:path` only. Everything else (file:, ext::, git://,
 * http://, a local path) is refused, and so is anything starting with `-`, which git would parse
 * as an option (`--upload-pack=...` is code execution). Whitespace/control chars are refused too.
 */
export function isValidCloneUrl(url: string): boolean {
  const u = url.trim()
  if (!u || u.startsWith('-') || /[\s\x00-\x1f]/.test(u)) return false
  // Host must start alphanumeric: `ssh://-oProxyCommand=...` is CVE-2017-1000117.
  return /^(https:\/\/[A-Za-z0-9][^/\s]*\/.+|ssh:\/\/[A-Za-z0-9][^/\s]*\/.+|git@[A-Za-z0-9][A-Za-z0-9.-]*:[^-].*)$/.test(u)
}

/**
 * The folder name `git clone` would create, or null when it would be empty, `.`/`..`, or contain a
 * separator: a crafted URL must never be able to write outside the parent (nodeterm deriveRepoDirName).
 */
export function deriveRepoDirName(url: string): string | null {
  const trimmed = url.trim().replace(/\/+$/, '').replace(/\.git$/i, '')
  const base = trimmed.split(/[/:\\]/).pop() ?? ''
  return isSafeFolderName(base) ? base : null
}

/** One path segment, not `.`/`..`, no separators or control chars (Orca repos:create name rule). */
export function isSafeFolderName(name: string): boolean {
  return name !== '' && name !== '.' && name !== '..' && !/[\\/\x00-\x1f]/.test(name) && name.length <= 255
}

/** Last `<phase>:  NN%` line in a stderr chunk (git overwrites lines with \r). nodeterm verbatim. */
export function parseCloneProgress(chunk: string): CloneProgress | null {
  let out: CloneProgress | null = null
  for (const line of chunk.split(/[\r\n]+/)) {
    const m = line.match(/([A-Za-z][A-Za-z\s-]*):\s+(\d+)%/)
    if (m) out = { phase: m[1].trim(), percent: Math.min(100, parseInt(m[2], 10)) }
  }
  return out
}

/** `https://user:secret@host` -> `https://***@host`: git echoes the URL in its errors. */
export function redactCredentials(s: string): string {
  return s.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, '$1***@')
}

/**
 * `host/owner/repo`, lowercased, for "is this the same repo": https, ssh:// and scp-style forms and
 * `owner/repo` shorthand all meet here; user, port, trailing `/` and `.git` are dropped. null when
 * it does not read as a remote URL.
 */
export function normalizeRepoUrl(input: string): string | null {
  const u = expandCloneUrl(input)
  const m = u.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/\s]+@)?([^/:\s]+)(?::\d+)?\/(.+)$/i) ?? u.match(/^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/)
  if (!m) return null
  const path = m[2].replace(/\/+$/, '').replace(/\.git$/i, '').replace(/^\/+/, '')
  return path ? `${m[1]}/${path}`.toLowerCase() : null
}

export const AUTH_HINT = 'Authentication required: run `gh auth login` (or set up an SSH key), then try again.'
const AUTH_FAILURE = /authentication failed|could not read (username|password)|terminal prompts disabled|permission denied \(publickey|repository not found|returned error: 40[13]/i

/**
 * Readable one-liner from git's stderr tail: the last `fatal:`/`error:` line (nodeterm), ANSI
 * stripped, credentials redacted, plus the `gh auth login` hint when it reads as an auth failure.
 */
export function cloneErrorMessage(stderrTail: string): string {
  // eslint-disable-next-line no-control-regex -- strips ANSI SGR (git colours fatal lines on some setups)
  const lines = stderrTail.replace(/\x1b\[[0-9;]*m/g, '').split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean)
  const fatal = [...lines].reverse().find((l) => /^(fatal|error):/i.test(l)) ?? lines.pop() ?? 'Clone failed.'
  const msg = redactCredentials(fatal)
  return AUTH_FAILURE.test(stderrTail) ? `${msg} — ${AUTH_HINT}` : msg
}
