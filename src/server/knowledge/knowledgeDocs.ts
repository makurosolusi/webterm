// Doc ingest for the knowledge index (RND/27 4.4): a fixed list of project docs, split per heading,
// redacted, size-capped. Doc text is data for retrieval, never instructions to execute.
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { redactSecrets } from '../redactSecrets'
import { KB_MAX_DOC_BYTES } from './knowledgeStore'
import { readTextSafe } from './knowledgeScan'

export interface DocSection { path: string; heading: string; text: string }

const DOC_FILES = ['CLAUDE.md', 'AGENTS.md', 'README.md'] as const
const CHANGELOG_LINES = 60
const DECISIONS_DIR = 'docs/decisions'
const MAX_DECISION_FILES = 50
const MAX_SECTIONS_PER_FILE = 200
const MAX_SECTION_CHARS = 4000
const HEADING = /^(#{1,4})\s+(.+?)\s*$/

/** Splits markdown into heading-delimited sections (fenced code is not scanned for headings). */
export function splitMarkdown(path: string, markdown: string): DocSection[] {
  const sections: DocSection[] = []
  let heading = '(top)'
  let buf: string[] = []
  let fenced = false
  const flush = (): void => {
    const text = buf.join('\n').trim()
    if (text && sections.length < MAX_SECTIONS_PER_FILE) sections.push({ path, heading, text: text.slice(0, MAX_SECTION_CHARS) })
    buf = []
  }
  for (const line of markdown.split('\n')) {
    if (line.startsWith('```')) fenced = !fenced
    const m = fenced ? null : HEADING.exec(line)
    if (m) { flush(); heading = m[2] ?? heading } else buf.push(line)
  }
  flush()
  return sections
}

function packageSection(text: string): DocSection[] {
  try {
    const pkg = JSON.parse(text) as { name?: string; scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
    const scripts = Object.entries(pkg.scripts ?? {}).map(([k, v]) => `${k}: ${v}`)
    const deps = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]
    return [{ path: 'package.json', heading: 'scripts and dependencies', text: [`name: ${pkg.name ?? ''}`, ...scripts, `dependencies: ${deps.join(' ')}`].join('\n') }]
  } catch (err) {
    return [{ path: 'package.json', heading: 'unparsable', text: `package.json is not valid JSON: ${(err as Error).message}` }]
  }
}

function decisionFiles(root: string): string[] {
  try {
    return readdirSync(join(root, DECISIONS_DIR)).filter((f) => f.endsWith('.md')).sort().slice(0, MAX_DECISION_FILES).map((f) => `${DECISIONS_DIR}/${f}`)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'ENOTDIR') return []
    throw err
  }
}

/** Collects redacted doc sections of a project; missing docs are skipped, files outside the root never read. */
export function collectDocs(root: string): DocSection[] {
  const out: DocSection[] = []
  const paths = [...DOC_FILES, 'CHANGELOG.md', ...decisionFiles(root)]
  for (const rel of paths) {
    const raw = readTextSafe(root, rel, KB_MAX_DOC_BYTES)
    if (raw === null) continue
    const text = rel === 'CHANGELOG.md' ? raw.split('\n').slice(0, CHANGELOG_LINES).join('\n') : raw
    out.push(...splitMarkdown(rel, text))
  }
  const pkg = readTextSafe(root, 'package.json', KB_MAX_DOC_BYTES)
  if (pkg !== null) out.push(...packageSection(pkg))
  return out.map((s) => ({ ...s, text: redactSecrets(s.text) }))
}
