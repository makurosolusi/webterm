// Repo-wide resize policy (same static-scan approach as iconTooltipPolicy.test.ts): resize handles
// show only in a node's explicit resize mode, so NodeResizer is used in exactly one place, the
// shared NodeLayoutResizer. A direct use would bring back "every click shows the handles".
import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const clientRoot = path.join(repoRoot, 'src/client')
const ALLOWED = 'src/client/nodeResize/NodeLayoutResizer.tsx'

/** 1-based lines of `source` that import or use `NodeResizer` (comments ignored). */
export function findNodeResizerUses(source: string): number[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' ')).replace(/\/\/[^\n]*/g, '')
  return code.split('\n').flatMap((line, i) => (/\bNodeResizer\b/.test(line) ? [i + 1] : []))
}

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(entries.map((e) => (e.isDirectory() ? filesUnder(path.join(directory, e.name)) : [path.join(directory, e.name)])))
  return files.flat()
}

describe('node resize policy', () => {
  it('uses NodeResizer only inside the shared NodeLayoutResizer', async () => {
    const files = (await filesUnder(clientRoot)).filter((f) => f.endsWith('.tsx') && !f.endsWith('.test.tsx'))
    const violations: string[] = []
    for (const file of files.sort()) {
      const rel = path.relative(repoRoot, file)
      if (rel === ALLOWED) continue
      for (const line of findNodeResizerUses(await readFile(file, 'utf8'))) violations.push(`${rel}:${line}`)
    }
    expect(violations, `Direct NodeResizer use; go through NodeLayoutResizer:\n${violations.join('\n')}`).toEqual([])
    expect(findNodeResizerUses(await readFile(path.join(repoRoot, ALLOWED), 'utf8')).length).toBeGreaterThan(0)
  })

  it('catches a planted direct use, import or JSX, and ignores comments and look-alike names', () => {
    const planted = [
      "import { Handle, NodeResizer } from '@xyflow/react'",
      '// NodeResizer in a comment is fine',
      '/* so is NodeResizer here */',
      'type P = NodeResizerProps',
      '      <NodeResizer isVisible={!!selected} />',
    ].join('\n')
    expect(findNodeResizerUses(planted)).toEqual([1, 5])
    expect(findNodeResizerUses("import { NodeLayoutResizer } from './nodeResize/NodeLayoutResizer'")).toEqual([])
  })
})
