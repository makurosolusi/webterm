// Bun-only (Bun.YAML, Bun.Glob): real fixture repo on disk.
import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { put, sh } from '../knowledge/knowledgeFixture.testutil'
import { discoverRules, globMatches, parseFrontmatter, ruleActive, rulesBlock } from './rulesLoader'

function rulesRepo(claudeMd = '# Project\n'): string {
  const dir = mkdtempSync(join(tmpdir(), 'rules-'))
  sh(dir, 'init', '-q')
  put(dir, {
    '.webterm/rules/style.md': 'Use two-space indent.\n',
    '.webterm/rules/api.md': '---\nglobs: ["src/server/**/*.ts"]\ndescription: Server API conventions\n---\nReturn coded errors.\n',
    '.cursor/rules/react.mdc': '---\ndescription: React components\nglobs: "*.tsx, src/client/**"\nalwaysApply: false\n---\nUse function components.\n',
    '.cursor/rules/db.mdc': '---\ndescription: Read before touching migrations\n---\nAlways add a migration.\n',
    '.cursor/rules/bare.mdc': 'No frontmatter: manual.\n',
    '.cursor/rules/broken.mdc': '---\nglobs: [unclosed\n---\nBody\n',
    'AGENTS.md': 'Run tests before done.\n',
    'pkg/sub/AGENTS.md': 'Sub package rule.\n',
    'CLAUDE.md': claudeMd,
  })
  sh(dir, 'add', '.')
  sh(dir, 'commit', '-q', '-m', 'init')
  return dir
}

test('glob matching: slash-free globs match at any depth, path globs are anchored', () => {
  expect(globMatches('*.tsx', 'src/client/App.tsx')).toBe(true)
  expect(globMatches('src/server/**/*.ts', 'src/server/a/b.ts')).toBe(true)
  expect(globMatches('src/server/**/*.ts', 'lib/src/server/a.ts')).toBe(false)
  expect(globMatches('./docs/*.md', 'docs/a.md')).toBe(true)
})

test('frontmatter: parsed, absent, and broken', () => {
  expect(parseFrontmatter('---\ndescription: x\n---\nbody').meta).toEqual({ description: 'x' })
  expect(parseFrontmatter('plain').body).toBe('plain')
  expect(parseFrontmatter('---\nglobs: [a\n---\nb').error).toContain('frontmatter')
})

test('discover: every source with its mode and loader', async () => {
  const root = rulesRepo()
  const rules = await discoverRules(root)
  const by = Object.fromEntries(rules.map((r) => [r.path, `${r.source}/${r.mode}/${r.loadedBy}`]))
  expect(by).toEqual({
    '.webterm/rules/api.md': 'webterm/auto/webterm',
    '.webterm/rules/style.md': 'webterm/always/webterm',
    '.cursor/rules/bare.mdc': 'cursor/manual/webterm',
    '.cursor/rules/broken.mdc': 'cursor/manual/webterm',
    '.cursor/rules/db.mdc': 'cursor/agent/webterm',
    '.cursor/rules/react.mdc': 'cursor/auto/webterm',
    'AGENTS.md': 'agents-md/always/webterm',
    'CLAUDE.md': 'claude-md/always/claude-code',
    'pkg/sub/AGENTS.md': 'agents-md/auto/webterm',
  })
  expect(rules.find((r) => r.path === '.cursor/rules/react.mdc')?.globs).toEqual(['*.tsx', 'src/client/**'])
  expect(rules.find((r) => r.path === '.cursor/rules/broken.mdc')?.error).toContain('frontmatter')
  rmSync(root, { recursive: true, force: true })
})

test('relevance: glob rules load only when a matching file was touched; Claude Code files are never re-injected', async () => {
  const root = rulesRepo()
  const rules = await discoverRules(root)
  const none = rulesBlock(rules, [])
  expect(none.included).toEqual(['.webterm/rules/style.md', 'AGENTS.md'])
  expect(none.listed).toEqual(['.cursor/rules/db.mdc'])
  expect(none.text).toContain('Read before touching migrations')
  expect(none.text).not.toContain('Use function components')
  const touched = rulesBlock(rules, ['src/client/Panel.tsx', 'pkg/sub/x.go'])
  expect(touched.included).toEqual(['.webterm/rules/style.md', '.cursor/rules/react.mdc', 'AGENTS.md', 'pkg/sub/AGENTS.md'])
  expect(touched.text).toContain('(applies to *.tsx, src/client/**)')
  expect(touched.included).not.toContain('CLAUDE.md')
  const api = rules.find((r) => r.path === '.webterm/rules/api.md')
  expect(api && ruleActive(api, ['src/server/x/y.ts'])).toBe(true)
  expect(rulesBlock(rules, [], 60).included).toEqual(['.webterm/rules/style.md'])
  rmSync(root, { recursive: true, force: true })
})

test('AGENTS.md imported by CLAUDE.md is left to Claude Code', async () => {
  const root = rulesRepo('# Project\n@AGENTS.md\n')
  const rules = await discoverRules(root)
  expect(rules.find((r) => r.path === 'AGENTS.md')?.loadedBy).toBe('claude-code')
  expect(rulesBlock(rules, []).included).toEqual(['.webterm/rules/style.md'])
  rmSync(root, { recursive: true, force: true })
})
