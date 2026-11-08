// Every tool the server registers has a plain label. Reads the server defs as text (importing them would pull bun:sqlite).
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { TOOL_LABELS, toolLabel } from './toolLabels'

const SERVER = fileURLToPath(new URL('../../server/', import.meta.url))
const DEFS = join(SERVER, 'central/tools/defs')
const FILES = [
  ...readdirSync(DEFS).filter((f) => f.endsWith('.ts') && !f.includes('.test.')).map((f) => join(DEFS, f)),
  join(SERVER, 'knowledge/repoMap.def.ts'), join(SERVER, 'blackboard/blackboard.defs.ts'),
]
/** A tool def: `name: '<x>'` followed closely by its `summary:`, or a `<X>_TOOL = '<x>'` name constant. */
const DEF = /name:\s*'([a-z_.]+)'[\s\S]{0,80}?summary:|_TOOL\s*=\s*'([a-z_.]+)'/g
const serverTools = FILES.flatMap((f) => [...readFileSync(f, 'utf8').matchAll(DEF)].map((m) => (m[1] ?? m[2]) as string))

describe('tool labels', () => {
  it('finds the server tools', () => {
    expect(serverTools.length).toBeGreaterThanOrEqual(37)
    expect(serverTools).toContain('repo.map')
    expect(serverTools).toContain('blackboard.read')
  })

  it('every server tool has a plain title and sentence', () => {
    expect(serverTools.filter((n) => !TOOL_LABELS[n])).toEqual([])
    for (const [name, l] of Object.entries(TOOL_LABELS)) {
      expect(l.title, name).toMatch(/^[A-Z]/)
      expect(l.text, name).toMatch(/\.$/)
    }
  })

  it('an unknown tool falls back to its name and server summary', () => {
    expect(toolLabel('x.y', 'Raw summary.')).toEqual({ title: 'x.y', text: 'Raw summary.' })
  })
})
