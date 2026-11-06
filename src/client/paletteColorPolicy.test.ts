// Theme-color policy (ui-210-8; same static-scan approach as iconTooltipPolicy.test.ts): client
// screens color warnings/errors/success with `--vscode-*` tokens, never a literal Tailwind palette
// class (`border-amber-500/50`, `text-red-600`), which ignores the active theme (light,
// high-contrast). Existing offenders are frozen below with their count: the list may only shrink.
import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const clientRoot = path.join(repoRoot, 'src/client')
const PALETTE_CLASS = /[a-z]-(?:amber|red|green|yellow)-\d{3}\b/g

/** Files that predate the policy, with how many palette classes each still has. Fix, then lower. */
const FROZEN: Record<string, number> = {
  'src/client/ClaudeProviderCommand.tsx': 3,
  'src/client/ControlPanel.tsx': 2,
  'src/client/ControlPanelField.tsx': 1,
  'src/client/TerminalCore.offline.tsx': 1,
  'src/client/bakeoff/BakeoffHost.tsx': 3,
  'src/client/claudeLauncher/ClaudeLaunchProfilesCard.tsx': 1,
  'src/client/claudeLauncher/LaunchSteps.tsx': 1,
  'src/client/replay/ReplayHost.tsx': 2,
  'src/client/templates/TemplatesHost.tsx': 3,
}

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(entries.map((entry) => {
    const entryPath = path.join(directory, entry.name)
    return entry.isDirectory() ? filesUnder(entryPath) : [entryPath]
  }))
  return files.flat()
}

describe('palette color policy', () => {
  it('has no literal amber/red/green/yellow palette classes outside the frozen list', async () => {
    const files = (await filesUnder(clientRoot)).filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
    const found: Record<string, number> = {}
    for (const file of files.sort()) {
      const count = (await readFile(file, 'utf8')).match(PALETTE_CLASS)?.length ?? 0
      if (count) found[path.relative(repoRoot, file)] = count
    }
    const over = Object.entries(found).filter(([rel, n]) => n > (FROZEN[rel] ?? 0)).map(([rel, n]) => `${rel}: ${n}`)
    expect(over, `Use --vscode-* tokens instead of palette classes:\n${over.join('\n')}`).toEqual([])
  })

  it('keeps the workspace-create notices on theme tokens', async () => {
    const src = await readFile(path.join(clientRoot, 'workspaceCreate/CreateNotices.tsx'), 'utf8')
    expect(src).toContain('--vscode-inputValidation-warningBorder')
    expect(src.match(PALETTE_CLASS)).toBeNull()
  })
})
