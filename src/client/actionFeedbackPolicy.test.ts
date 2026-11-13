// Repo-wide action feedback policy (same static-scan approach as iconTooltipPolicy.test.ts): async
// buttons go through useAction + ActionButton (busy, result time, failure + Retry), and in settings
// screens a disabled control says why (lock / disabledReason / IconTooltip) instead of swapping its hint.
import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { findActionPolicyViolations, isSettingsFile, type ActionPolicyViolation } from './components/ui/action.policy'

type Reason = ActionPolicyViolation['reason']
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const clientRoot = path.join(repoRoot, 'src/client')
const uiRoot = path.join(clientRoot, 'components', 'ui') + path.sep

/**
 * Not yet migrated (audit wkr-ux-458 + addendum). This list only shrinks: migrate a file, delete its
 * entry; the staleness test below fails when an entry no longer has that violation.
 */
const PENDING: Record<string, Reason[]> = {}

/** Permanent exceptions: the control already gives its own complete feedback. */
const PERMANENT: Record<string, { reasons: Reason[]; why: string }> = {
  'src/client/BrowserCookieDialog.tsx': { reasons: ['async-click'], why: 'copy-to-clipboard with its own "Copied" state' },
  'src/client/central/health/HealthView.tsx': { reasons: ['async-click'], why: 'Scan now: own running state, spinner and last-scan line' },
  'src/client/central/health/HealthAnalysis.tsx': { reasons: ['async-click'], why: 'deep analysis: own running, cooldown, failed and last-result states' },
  'src/client/DiffNode.tsx': { reasons: ['async-click'], why: 'node Close: rf.deleteElements removes the node; the close-confirm dialog is the feedback' },
  'src/client/PlanNode.tsx': { reasons: ['async-click'], why: 'node Close: rf.deleteElements removes the node; the close-confirm dialog is the feedback' },
  'src/client/mcpapps/McpAppNode.tsx': { reasons: ['async-click'], why: 'node Close: rf.deleteElements removes the node; the close-confirm dialog is the feedback' },
  'src/client/viewers/BinaryPlaceholder.tsx': { reasons: ['async-click'], why: 'copy-to-clipboard with its own "Copied" state' },
  'src/client/Welcome.tsx': { reasons: ['async-click'], why: 'Reopen waits for the reopen-confirm dialog, which is the feedback' },
  'src/client/Dock.workspaceDialog.tsx': { reasons: ['async-click'], why: 'worktree checkbox: best-effort pre-fill of the repo folder, not a user action' },
}

const exempt = (rel: string): Reason[] => [...(PENDING[rel] ?? []), ...(PERMANENT[rel]?.reasons ?? [])]

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(entries.map((entry) => {
    const entryPath = path.join(directory, entry.name)
    return entry.isDirectory() ? filesUnder(entryPath) : [entryPath]
  }))
  return files.flat()
}

/** Violations per repo-relative client screen (.tsx outside components/ui, tests excluded). */
async function scan(): Promise<Map<string, ActionPolicyViolation[]>> {
  const files = (await filesUnder(clientRoot)).filter((f) => f.endsWith('.tsx') && !f.endsWith('.test.tsx') && !f.startsWith(uiRoot))
  const out = new Map<string, ActionPolicyViolation[]>()
  for (const file of files.sort()) {
    out.set(path.relative(repoRoot, file), findActionPolicyViolations(await readFile(file, 'utf8'), isSettingsFile(path.relative(clientRoot, file))))
  }
  return out
}

describe('action feedback policy', () => {
  it('async buttons use useAction/ActionButton, and disabled settings controls say why', async () => {
    const violations: string[] = []
    for (const [rel, list] of await scan()) {
      for (const v of list) if (!exempt(rel).includes(v.reason)) violations.push(`${rel}:${v.line} ${v.reason} ${v.snippet.trim()}`)
    }
    expect(violations, `Action feedback violations:\n${violations.join('\n')}`).toEqual([])
  })

  it('has no stale exemptions (a migrated file leaves PENDING)', async () => {
    const found = await scan()
    const stale: string[] = []
    for (const rel of new Set([...Object.keys(PENDING), ...Object.keys(PERMANENT)])) {
      for (const r of exempt(rel)) if (!found.get(rel)?.some((v) => v.reason === r)) stale.push(`${rel} ${r}`)
    }
    expect(stale).toEqual([])
  })

  it('the scanner flags bad samples and passes good ones (control)', () => {
    const reasons = (src: string, settings = false): Reason[] => findActionPolicyViolations(src, settings).map((v) => v.reason)
    expect(reasons('<Button onClick={async () => { await save() }}>Save</Button>')).toEqual(['async-click'])
    expect(reasons('<Button onClick={() => void save()}>Save</Button>')).toEqual(['async-click'])
    expect(reasons('const save = async () => {}\n<Button onClick={save}>Save</Button>')).toEqual(['async-click'])
    expect(reasons('<Switch onCheckedChange={(on) => void toggle(on)} />')).toEqual(['async-click'])
    expect(reasons('<ActionButton action={a} busyLabel="Saving…">Save</ActionButton>')).toEqual([])
    expect(reasons('const open = () => {}\n<Button onClick={open}>Open</Button>')).toEqual([])
    expect(reasons('<Button disabled={!valid}>Save</Button>', true)).toEqual(['disabled-no-reason'])
    expect(reasons('<Button disabled={!valid}>Save</Button>', false)).toEqual([])
    expect(reasons('<Button disabled={saving || s.pending}>Save</Button>', true)).toEqual([])
    expect(reasons('<SelectField id="x" lock={l} disabled={!ok} />', true)).toEqual([])
    expect(reasons('<IconTooltip label="Save" disabled={!ok} disabledReason="Nothing to save">\n  <Button disabled={!ok}>Save</Button>', true)).toEqual([])
    expect(reasons('<SelectField id="x" hint={on ? A : B} disabled={on} />', true)).toEqual(['hint-swap', 'disabled-no-reason'])
    expect(isSettingsFile('SettingsAgents.tsx') && isSettingsFile('setup/setup.ui.tsx') && !isSettingsFile('Welcome.tsx')).toBe(true)
  })
})
