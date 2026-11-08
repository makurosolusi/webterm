// YAML frontmatter of a Markdown file (editor preview only). marked knows no frontmatter: the
// opening `---` became an <hr> and the `key: value` lines plus the closing `---` a setext <h2>,
// so a skill file previewed as one huge bold heading. The block is cut off before rendering and
// shown on its own, as GitHub does.

export interface Frontmatter { front: string | null; body: string }

// Only a block that opens on the very first line counts; closes on `---` or YAML's `...`.
const FRONT_RE = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n?^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m

/** Splits a leading `---` … `---` block off `src`; `front` is null when there is none. */
export function splitFrontmatter(src: string): Frontmatter {
  const m = FRONT_RE.exec(src)
  if (!m || m.index !== 0) return { front: null, body: src }
  return { front: m[1] ?? '', body: src.slice(m[0].length) }
}

const KEY_RE = /^([^\s#:-][^:]*?):(?:[ \t]+(.*))?$/

const unquote = (v: string): string =>
  v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.endsWith(v[0]) ? v.slice(1, -1) : v

/**
 * The frontmatter as `[key, value]` rows when every top-level value is a one-line scalar, or null
 * when anything is nested (indented lines, lists, `|`/`>` block scalars, empty values): the caller
 * then shows the raw YAML instead. ponytail: not a YAML parser; flat files only, raw block otherwise.
 */
export function frontmatterRows(front: string): Array<[string, string]> | null {
  const rows: Array<[string, string]> = []
  for (const line of front.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const m = KEY_RE.exec(line)
    const value = m?.[2]?.trim()
    if (!m || !value || value === '|' || value === '>' || /^[|>][-+]?\d*$/.test(value)) return null
    rows.push([m[1]!.trim(), unquote(value)])
  }
  return rows
}
