/**
 * P4b render/parse: Markdown with ordered JSON frontmatter <-> `MemoryFileRecord`. Pure
 * functions only; redaction happens before anything is written or compared.
 */
import { redactSecrets } from '../redactSecrets'
import { MemoryAuthorityError, MemoryConflictError } from './memoryModel'
import type { Memory } from './memoryModel'
import { MemoryFileError } from './memoryFilePath'

export const DIGEST_PATTERN = /^(?:sha256:)?([0-9a-f]{64})$/i
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

export function oneLine(value: string, max = 300): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
}

function redacted(value: string, max: number): string {
  return redactSecrets(oneLine(value, max))
}

function evidenceField(digest: string | null | undefined): string | null {
  if (digest === null || digest === undefined) return null
  const match = DIGEST_PATTERN.exec(digest.trim())
  if (match === null) throw new MemoryFileError('memory file evidence must be a sha256 digest')
  return `sha256:${match[1].toLowerCase()}`
}

/** Deterministic Markdown with ordered JSON frontmatter. */
export function renderMemoryFile(memory: Memory, evidenceDigest?: string | null): string {
  if (memory.projectId === null) throw new MemoryFileError('memory file requires a project')
  if (memory.status !== 'fact') throw new MemoryConflictError(`memory file requires status fact, got ${memory.status}`)
  if (memory.scope === 'core') throw new MemoryAuthorityError('memory file: scope core is human-only, never exported')
  const frontmatter = {
    id: memory.id,
    projectId: memory.projectId,
    scope: memory.scope,
    key: memory.key,
    title: oneLine(memory.title),
    sourceKind: memory.sourceKind === null ? null : redacted(memory.sourceKind, 120),
    sourceRef: memory.sourceRef === null ? null : redacted(memory.sourceRef, 500),
    status: 'fact',
    evidence: evidenceField(evidenceDigest),
    updatedAt: memory.updatedAt,
  }
  const body = redactSecrets(memory.body).replace(/\s+$/, '')
  return `---\n${JSON.stringify(frontmatter, null, 2)}\n---\n\n# ${frontmatter.title}\n\n${body}\n`
}

export interface MemoryFileRecord {
  id: string; projectId: string; scope: 'project' | 'scratch'; key: string; title: string
  sourceKind: string | null; sourceRef: string | null; status: 'fact'
  evidence: string | null; updatedAt: number; body: string
}

function textField(fm: Record<string, unknown>, name: string, label: string, required: boolean): string | null {
  const value = fm[name]
  if (value === null || value === undefined) {
    if (required) throw new MemoryFileError(`${label}: frontmatter.${name} must be a non-empty string`)
    return null
  }
  if (typeof value !== 'string' || (required && value.trim() === '')) {
    throw new MemoryFileError(`${label}: frontmatter.${name} must be a string`)
  }
  return value
}

/** Parses one file; `core` is rejected because it is never file-backed. */
export function parseMemoryFile(text: string, label = 'memory file'): MemoryFileRecord {
  const match = FRONTMATTER.exec(text)
  if (match === null) throw new MemoryFileError(`${label}: missing JSON frontmatter`)
  let raw: unknown
  try {
    raw = JSON.parse(match[1])
  } catch (err) {
    throw new MemoryFileError(`${label}: frontmatter is not valid JSON`, { cause: err })
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new MemoryFileError(`${label}: frontmatter must be a JSON object`)
  }
  const fm = raw as Record<string, unknown>
  if (fm['scope'] === 'core') {
    throw new MemoryFileError(`${label}: scope core is human-only and never rebuilt from files`)
  }
  if (fm['scope'] !== 'project' && fm['scope'] !== 'scratch') {
    throw new MemoryFileError(`${label}: frontmatter.scope must be project or scratch`)
  }
  if (fm['status'] !== 'fact') throw new MemoryFileError(`${label}: frontmatter.status must be fact`)
  const updatedAt = fm['updatedAt']
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) {
    throw new MemoryFileError(`${label}: frontmatter.updatedAt must be epoch-ms`)
  }
  const rest = text.slice(match[0].length)
  const heading = /^\s*#\s+[^\n]*\n/.exec(rest)
  const evidence = textField(fm, 'evidence', label, false)
  return {
    id: textField(fm, 'id', label, true)!,
    projectId: textField(fm, 'projectId', label, true)!,
    scope: fm['scope'],
    key: textField(fm, 'key', label, true)!,
    title: textField(fm, 'title', label, true)!,
    sourceKind: textField(fm, 'sourceKind', label, false),
    sourceRef: textField(fm, 'sourceRef', label, false),
    status: 'fact',
    evidence: evidence === null ? null : evidenceField(evidence),
    updatedAt,
    body: (heading === null ? rest : rest.slice(heading[0].length)).replace(/^\s+|\s+$/g, ''),
  }
}
