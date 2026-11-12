// Per-workspace launch mode: a terminal Claude session launches with its workspace's approval level
// (override, else global) and the level is remembered, so a later change counts it as "keeps old mode".
import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DIR = mkdtempSync(join(tmpdir(), 'webterm-sessions-level-'))
const saved = { HOME: process.env.HOME, WEBTERM_DATA_DIR: process.env.WEBTERM_DATA_DIR, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR }
process.env.HOME = DIR
process.env.WEBTERM_DATA_DIR = join(DIR, 'data')
process.env.CLAUDE_CONFIG_DIR = join(DIR, 'claude')
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  rmSync(DIR, { recursive: true, force: true })
})

import { Sessions } from './sessions'
import { FakePty } from './fakePty.testutil'
import { approvalLevelFor, type ApprovalSettings } from '../shared/settings.projectApprovalLevels'
import { launchModeFor, sessionModeName, staleLaunchCount } from './permission/permission.mode'

const SID = '11111111-2222-3333-4444-555555555555'
const WS_OF: Record<string, string> = { a: 'w-danger', b: 'w-plain' }

test('each node launches with its workspace level; a later change counts the running ones as stale', () => {
  let s: ApprovalSettings = { skipApprovals: false, claudePermissionMode: 'auto', projectApprovalLevels: { 'w-danger': 'never' } }
  const cmds: (string | undefined)[] = []
  const sessions = new Sessions({
    spawn: (o) => { cmds.push(o.cmd); return new FakePty(1000 + cmds.length) },
    launchFor: (nodeId) => {
      const workspaceId = WS_OF[nodeId] ?? null
      return { mode: launchModeFor(s, workspaceId), workspaceId, level: approvalLevelFor(s, workspaceId) }
    },
  })
  const open = (id: string) => sessions.open({ t: 'open', id, cols: 80, rows: 24, cmd: 'claude', agentId: 'claude', sessionId: SID }, () => {})
  open('a')
  open('b')
  expect(cmds[0]).toContain('--permission-mode bypassPermissions')
  expect(cmds[1]).toContain('--permission-mode auto')
  expect(sessionModeName(s, 'a', 'w-danger')).toBe('danger')

  const live = (id: string) => sessions.isLive(id)
  expect(staleLaunchCount(s, live, 'w-danger')).toBe(0)
  s = { ...s, projectApprovalLevels: {} } // w-danger back to the global Auto
  expect(staleLaunchCount(s, live, 'w-danger')).toBe(1)
  expect(staleLaunchCount(s, live, 'w-plain')).toBe(0)
  expect(sessionModeName(s, 'a', 'w-danger')).toBe('danger') // keeps its launch mode until restarted
  sessions.close('a')
  expect(staleLaunchCount(s, live, 'w-danger')).toBe(0)
})
