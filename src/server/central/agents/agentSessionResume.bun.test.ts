// Root-lock for the resume launch: it is built by the SAME builder as the first spawn (launchLine), so the
// re-passed flags (--settings, --mcp-config, plugin, rules) are identical and only the id flag differs.
// Fake sessions, no PTY and no `claude`; data dir and HOME are temp.
import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DIR = mkdtempSync(join(tmpdir(), 'webterm-resume-'))
process.env.WEBTERM_DATA_DIR = DIR
const ORIGINAL_HOME = process.env.HOME
process.env.HOME = DIR
afterAll(() => {
  process.env.HOME = ORIGINAL_HOME
  rmSync(DIR, { recursive: true, force: true })
})

import type { OpenMsg } from '../../../shared/protocol'
import { RESUME_TURN_MAX_AGE_VAR, RESUME_TURN_VAR } from '../../agentEnv'
import { launchLine } from '../../launchLine'
import type { WorkerSessionPort } from '../../orchestrator/workerRuntimeSession'
import type { WorktreeService } from '../../orchestrator/worktree'
import { createAgentSpawner } from '../../spawn/agentSpawn'
import type { AgentRecord } from '../contracts'
import type { AgentCatalog, CatalogEntry } from './agentCatalog'
import { agentSessionId } from './agentCanvas'
import { createAgentHost } from './agentHost'
import { RESUME_MAX_AGE_MS } from './agentSessionResume'

const entry = { kind: 'claude', builtin: true, launchLine: 'claude', headlessArgv: null, tier: 'R2', childEnv: () => ({}) } as unknown as CatalogEntry
const catalog: AgentCatalog = { resolve: (k) => (k === 'claude' ? entry : null), kinds: () => [] }
const rec = { id: 'a1', projectId: 'p1', kind: 'claude', role: 'worker', owner: 'central:p1', taskId: null } as unknown as AgentRecord

function host() {
  const opens: Array<Record<string, unknown>> = []
  const sessions = { open: (i: Record<string, unknown>) => { opens.push(i) } } as unknown as WorkerSessionPort
  const spawner = createAgentSpawner({ ancestors: () => [], registerSpawn: () => {}, record: () => {}, onPtyExit: () => {} })
  return { h: createAgentHost({ sessions, worktrees: {} as WorktreeService, repoOf: () => null, catalog, spawn: spawner.spawn }), opens }
}
const toMsg = (o: Record<string, unknown>): OpenMsg => ({ t: 'open', id: o.nodeId as string, cols: 80, rows: 24, cwd: o.cwd as string, cmd: o.cmd as string, agentId: 'claude', sessionId: o.sessionId as string, ...(o.resume ? { resume: true } : {}) })
const flagsWithout = (line: string, idFlag: string): string => line.replace(idFlag, '').replace(/\s+/g, ' ').trim()

test('resume: --resume <id>, same cwd and the same re-passed flags as the first spawn, env prefix on the command', async () => {
  const { h, opens } = host()
  await h.openPty(rec, '/wt/a1', 'c-a1')
  await h.resumePty!(rec, '/wt/a1', 'c-a1', RESUME_MAX_AGE_MS)
  const [first, again] = opens as [Record<string, unknown>, Record<string, unknown>]
  const sid = agentSessionId(rec) as string
  const firstLine = launchLine(toMsg(first)) as string
  const resumeLine = launchLine(toMsg(again)) as string
  expect(again.cwd).toBe(first.cwd)
  expect(again.nodeId).toBe(first.nodeId)
  expect(again.sessionId).toBe(sid)
  expect(again.resume).toBe(true)
  expect(first.resume === undefined).toBe(true)
  expect(firstLine).toContain(`--session-id ${sid}`)
  expect(resumeLine).toContain(`--resume ${sid}`)
  expect(resumeLine).not.toContain('--session-id')
  for (const flag of ['--settings', '--mcp-config', '--append-system-prompt-file']) expect(resumeLine).toContain(flag)
  // The resume command line is the first one with the id flag swapped, plus the env prefix and without the boot prompt.
  const prefix = `${RESUME_TURN_VAR}=1 ${RESUME_TURN_MAX_AGE_VAR}=${RESUME_MAX_AGE_MS}`
  expect(resumeLine.startsWith(`${prefix} claude `)).toBe(true)
  const tail = (l: string, id: string) => flagsWithout(l.slice(l.indexOf(id)), id)
  expect(tail(resumeLine, `--resume ${sid}`)).toBe(tail(firstLine, `--session-id ${sid}`))
})

test('resume never carries a permission bypass flag', async () => {
  const { h, opens } = host()
  await h.resumePty!(rec, '/wt/a1', 'c-a1', RESUME_MAX_AGE_MS)
  expect(launchLine(toMsg(opens[0] as Record<string, unknown>)) as string).not.toMatch(/dangerously-skip-permissions|bypassPermissions/)
})
