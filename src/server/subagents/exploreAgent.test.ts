import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { EXPLORE_AGENT_MD, EXPLORE_TOOLS, explorePluginFlag, writeExplorePlugin } from './exploreAgent'

test('plugin layout: manifest names the agent file, agent frontmatter is read-only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wt-plugin-'))
  expect(writeExplorePlugin(dir)).toBe(dir)
  const manifest = JSON.parse(readFileSync(join(dir, '.claude-plugin', 'plugin.json'), 'utf8')) as { name: string; agents: string[] }
  expect(manifest).toMatchObject({ name: 'webterm', agents: ['./agents/explore.md'] })
  const md = readFileSync(join(dir, 'agents', 'explore.md'), 'utf8')
  expect(md).toBe(EXPLORE_AGENT_MD)
  const tools = /^tools: (.*)$/m.exec(md)?.[1]?.split(', ')
  expect(tools).toEqual([...EXPLORE_TOOLS])
  expect(tools).toContain('mcp__webterm__repo_map')
  for (const t of ['Edit', 'Write', 'Bash', 'NotebookEdit']) expect(tools).not.toContain(t)
  rmSync(dir, { recursive: true, force: true })
})

test('argv: one shell-quoted --plugin-dir with a colon-free argument', () => {
  const flag = explorePluginFlag(() => "/data/it's here/claude-plugin")
  expect(flag).toBe(`--plugin-dir '/data/it'\\''s here/claude-plugin'`)
  expect(explorePluginFlag(() => '/d/claude-plugin')).not.toContain(':')
})
