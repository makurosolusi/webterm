// Repo-wide tooltip policy (same static-scan approach as shadcnPolicy.test.ts): every icon-only
// control in a client screen goes through IconButton / IconTooltip, so it has a visible hint.
import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { findTooltipPolicyViolations, type TooltipPolicyViolation } from './components/ui/icon-button.policy'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const clientRoot = path.join(repoRoot, 'src/client')
const uiRoot = path.join(clientRoot, 'components', 'ui') + path.sep

/**
 * Deliberate exceptions, per file and reason. Explicit list, no globs: a new one must be added
 * here on purpose, with its reason.
 */
const EXEMPT: Record<string, TooltipPolicyViolation['reason'][]> = {
  // Menu rows are text rows; VS Code menus show an action's tooltip as a native title, and
  // vscode-overlay-fidelity / filesSlot.mutate tests pin that (disabled-reason hint on a row).
  'src/client/components/vscode/vscodeMenu.tsx': ['native-title'],
}

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(entries.map((entry) => {
    const entryPath = path.join(directory, entry.name)
    return entry.isDirectory() ? filesUnder(entryPath) : [entryPath]
  }))
  return files.flat()
}

describe('icon tooltip policy', () => {
  it('has no native titles, bare icon Buttons or untooltipped icon-only buttons outside components/ui', async () => {
    const files = (await filesUnder(clientRoot)).filter(
      (file) => file.endsWith('.tsx') && !file.endsWith('.test.tsx') && !file.startsWith(uiRoot),
    )
    const violations: string[] = []
    for (const file of files.sort()) {
      const rel = path.relative(repoRoot, file)
      for (const v of findTooltipPolicyViolations(await readFile(file, 'utf8'))) {
        if (!EXEMPT[rel]?.includes(v.reason)) violations.push(`${rel}:${v.line} ${v.reason} ${v.snippet.trim()}`)
      }
    }
    expect(violations, `Tooltip policy violations:\n${violations.join('\n')}`).toEqual([])
  })
})
