// Bun-only (Bun.Glob, real git fixture): the hook-side rules cache and its wiring into awarenessExtras.
import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Workspace } from '../../shared/workspace'
import { put, sh } from '../knowledge/knowledgeFixture.testutil'
import { RULES_CHANGED_HEADER, RULES_HOOK_MAX_CHARS, RULES_TTL_MS, type RulesSnapshot, createRulesAwareness } from './rulesAwareness'
import type { RuleFile } from './rulesLoader'

process.env.WEBTERM_DATA_DIR = mkdtempSync(join(tmpdir(), 'wt-rules-aw-')) // test-only: keep dataDir() out of the real home

const rule = (over: Partial<RuleFile>): RuleFile => ({
  path: 'AGENTS.md', source: 'agents-md', mode: 'always', description: '', globs: [], loadedBy: 'webterm', body: 'Run tests first.', chars: 16, ...over,
})

function harness(snap: () => RulesSnapshot | Error) {
  let clock = 0
  let loads = 0
  const errors: unknown[] = []
  const aw = createRulesAwareness({
    load: async () => { loads++; const s = snap(); if (s instanceof Error) throw s; return s },
    now: () => clock, onError: (_c, e) => errors.push(e),
  })
  return { aw, errors, loads: () => loads, tick: (ms: number) => { clock += ms } }
}

test('cold cache: SessionStart sends nothing and warms; the first prompt after the warm sends the block once', async () => {
  const h = harness(() => ({ rules: [rule({})], touched: [] }))
  expect(h.aw.next('n1', 'SessionStart', '/p')).toBeNull()
  await h.aw.warm('/p')
  expect(h.loads()).toBe(1) // the in-flight warm was reused
  expect(h.aw.next('n1', 'UserPromptSubmit', '/p')).toBe(`${RULES_CHANGED_HEADER}\nProject rule AGENTS.md:\nRun tests first.`)
  expect(h.aw.next('n1', 'UserPromptSubmit', '/p')).toBeNull()
  expect(h.aw.next('n1', 'SessionStart', '/p')).toBe('Project rule AGENTS.md:\nRun tests first.')
  expect(h.aw.next('n1', 'PreToolUse', '/p')).toBeNull()
})

test('a glob rule is re-sent once a matching file becomes touched (after the TTL refresh)', async () => {
  let touched: string[] = []
  const h = harness(() => ({ rules: [rule({ path: '.cursor/rules/ui.mdc', source: 'cursor', mode: 'auto', globs: ['*.tsx'], body: 'Function components.' })], touched }))
  await h.aw.warm('/p')
  expect(h.aw.next('n1', 'SessionStart', '/p')).toBeNull()
  touched = ['src/App.tsx']
  h.tick(RULES_TTL_MS)
  h.aw.next('n1', 'UserPromptSubmit', '/p') // stale: kicks the refresh, still answers from the old entry
  await h.aw.warm('/p')
  expect(h.aw.next('n1', 'UserPromptSubmit', '/p')).toContain('(applies to *.tsx)')
})

test('a failing load is logged, cached empty, and never throws into the hook', async () => {
  const h = harness(() => new Error('git exploded'))
  expect(h.aw.next('n1', 'SessionStart', '/p')).toBeNull()
  await h.aw.warm('/p')
  expect(h.errors).toHaveLength(1)
  expect(h.aw.next('n1', 'UserPromptSubmit', '/p')).toBeNull()
  expect(h.loads()).toBe(1)
  expect(h.aw.next('n1', 'SessionStart', '')).toBeNull()
})

test('the block stays within the hook budget', async () => {
  const h = harness(() => ({ rules: [rule({ body: 'x'.repeat(RULES_HOOK_MAX_CHARS * 2) }), rule({ path: '.webterm/rules/a.md', source: 'webterm' })], touched: [] }))
  await h.aw.warm('/p')
  const text = h.aw.next('n1', 'SessionStart', '/p') ?? ''
  expect(text.length <= RULES_HOOK_MAX_CHARS).toBe(true)
  expect(text).toContain('.webterm/rules/a.md')
})

test('wired: awarenessExtras carries the repo rules on SessionStart once warm', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rules-wire-'))
  sh(root, 'init', '-q')
  put(root, { 'AGENTS.md': 'Always run the zebra suite.\n' })
  sh(root, 'add', '.')
  sh(root, 'commit', '-q', '-m', 'init')
  const { awarenessExtras, projectRules } = await import('../awareness/awarenessHook')
  const ws = { id: 'w', name: 'B', cwd: root, viewport: { x: 0, y: 0, zoom: 1 }, updatedAt: 0, nodes: [{ id: 'a1', kind: 'agent', x: 0, y: 0, title: 'Main', agentId: 'claude' }], bridges: [] } as unknown as Workspace
  expect(awarenessExtras('a1', 'SessionStart', ws, null)).not.toContain('zebra')
  await projectRules.warm(root)
  expect(awarenessExtras('a1', 'UserPromptSubmit', ws, null)).toContain('Always run the zebra suite.')
  expect(awarenessExtras('a1', 'SessionStart', ws, null)).toContain('Project rule AGENTS.md:\nAlways run the zebra suite.')
  rmSync(root, { recursive: true, force: true })
})
