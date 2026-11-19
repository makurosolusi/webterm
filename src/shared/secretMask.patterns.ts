// Named patterns and limits for the pure secret detector (see secretMask.detect.ts).
// Every regex here is linear: unbounded runs are anchored by a lookbehind so a long
// run of token characters is scanned once, never re-tried from each offset (ReDoS).

/** Scan at most this many UTF-16 units; the rest is reported as `truncated`. */
export const MAX_SCAN_CHARS = 1024 * 1024

/** Values longer than this are never placeholders (also bounds placeholder regex cost). */
export const MAX_PLACEHOLDER_CHARS = 256

/** All-digit values up to this length are treated as ports/counters, not secrets. */
export const SHORT_NUMBER_MAX_DIGITS = 6

/** Base names whose entire content is secret. Tested against the file's base name. */
export const FILE_WIDE_NAME_PATTERNS: readonly RegExp[] = [
  /\.(?:pem|key|p12|pfx)$/i,
  /^id_(?:rsa|ed25519|ecdsa)(?:_[^.]*)?$/i, // no extension, so `.pub` never matches
  /^credentials\.json$/i,
  /^service-account.*\.json$/i,
  /^\.netrc$/i,
  /^\.pgpass$/i,
  /^kubeconfig(?:\..+)?$/i,
]

/** `.env` / `.env.*` files mask every value, except these template suffixes. */
export const ENV_TEMPLATE_SUFFIXES: readonly string[] = ['example', 'sample', 'template']

/** Content marker that makes the whole file secret regardless of its name. */
export const PRIVATE_KEY_BLOCK_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----/

/** Key names whose value is a secret. `AUTH` skips author/authors. */
export const SECRET_KEY_RE =
  /API[_-]?KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE[_-]?KEY|ACCESS[_-]?KEY|AUTH(?!OR)|CREDENTIAL/i

/**
 * `key: value` / `key=value` / `"key": value`, one line. Group 2 is the key; the match
 * ends where the value starts. The lookbehind keeps the scan linear.
 */
export const KEY_VALUE_SOURCE = '(?<![\\w.-])(["\']?)([\\w.-]+)\\1[ \\t]*[:=][ \\t]*'

/** Leading comment marker of a prose/commented line (`#`, `//`, `;`, `--`, `*`, `<!--`). */
export const COMMENT_MARKER_RE = /^[ \t]*(?:#+|\/\/+|;+|--|\*+|\/\*+|<!--)[ \t]*/

/** Optional `export ` / `- ` prefixes before a key (shell exports, YAML list items). */
export const KEY_LEAD_RE = /^[ \t]*(?:(?:export|-)[ \t]+)*/

/** YAML block scalar indicator (`|`, `>-`, `|2`): the value lives on the next line. */
export const BLOCK_SCALAR_RE = /^[|>][+-]?\d?$/

/** `scheme://user:pass@host`; group 1 is everything before the password, group 2 the password. */
export const CONNECTION_STRING_RE =
  /(?<![A-Za-z0-9+.-])([A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s:@/'"]+:)([^\s@/'"]+)@/g

/** Well-known token shapes. Each starts after a boundary so mid-run offsets are never retried. */
export const TOKEN_PATTERNS: readonly RegExp[] = [
  /(?<![\w-])sk-[\w-]{20,}/g, // OpenAI and Anthropic (sk-ant-...)
  /(?<![\w-])gh[pousr]_[A-Za-z0-9]{30,}/g,
  /(?<![\w-])github_pat_\w{22,}/g,
  /(?<![\w-])AKIA[0-9A-Z]{16}(?![0-9A-Z])/g,
  /(?<![\w-])xox[abpr]-[A-Za-z0-9-]{10,}/g,
  /(?<![\w-])glpat-[\w-]{20,}/g,
  /(?<![\w-])AIza[\w-]{35}/g,
  /(?<![\w-])npm_[A-Za-z0-9]{36}/g,
  /(?<![\w-])SG\.[\w-]{16,}\.[\w-]{16,}/g,
  /(?<![\w-])eyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]{5,}/g, // JWT, three segments
]

/** Lower-case literal values that are never secrets. */
export const PLACEHOLDER_WORDS: ReadonlySet<string> = new Set([
  'changeme', 'change-me', 'change_me', 'null', 'nil', 'none', 'undefined',
  'true', 'false', 'yes', 'no', 'string', 'number', 'boolean', 'example',
  'todo', 'tbd', 'redacted',
])

/** Value shapes that are placeholders: `xxx`, `***`, `...`, `<your-key>`, `your-api-key`. */
export const PLACEHOLDER_SHAPES: readonly RegExp[] = [
  /^[x*.\-_•…]+$/i,
  /^<[^<>]*>$/,
  /^your[-_ ]/i,
]

/** `${VAR}` / `${VAR:-x}` / `$VAR`: a value made only of these is a reference, not a secret. */
export const VARIABLE_REF_RE = /\$\{[^}]*\}|\$[A-Za-z_]\w*/g

/** Unquoted values that are code references (`process.env.X`, `req.body.token`), not literals. */
export const CODE_REFERENCE_RE =
  /^(?:[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+|(?:process\.env|os\.environ|Bun\.env|import\.meta\.env)\b.*);?$/
