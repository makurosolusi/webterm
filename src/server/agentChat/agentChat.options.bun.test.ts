import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CanUseTool, SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk'
import { DEFAULT_SETTINGS } from '../../shared/settings'
import type { AgentPermissionMode } from '../../shared/workspace'
import { PassThrough } from 'node:stream'
import { applyNodeClaudeProfile, registerClaudeLaunchSettings, registerDefaultProfileOverride } from '../claudeLauncher/claudeLauncher'
import type { SpawnImpl } from '../claudeLauncher/claudeSdkSpawn'
import { AGENT_CHAT_SETTING_SOURCES, agentChatPermissionMode, buildAgentChatOptions, createStderrTail } from './agentChat.options'

const allow: CanUseTool = async (_n, input) => ({ behavior: 'allow', updatedInput: input })
const configDir = mkdtempSync(join(tmpdir(), 'agent-chat-cfg-')) // test-only: never the real ~/.claude
const parentEnv = { PATH: '/usr/bin:/bin', HOME: '/home/test', CLAUDE_CONFIG_DIR: configDir }
const ENVMAN = { id: 'em', name: 'Envman', command: 'envman -e claude:work -- claude' }

function build(over: Partial<Parameters<typeof buildAgentChatOptions>[0]> = {}) {
  return buildAgentChatOptions({ nodeId: 'n-1', port: 8701, cwd: '/tmp/proj', mode: 'manual', canUseTool: allow, abort: new AbortController(), parentEnv, ...over })
}

afterEach(() => {
  registerClaudeLaunchSettings(() => DEFAULT_SETTINGS)
  registerDefaultProfileOverride(() => undefined)
})

describe('agentChatPermissionMode', () => {
  test('manual maps to default, the rest pass through', () => {
    expect(agentChatPermissionMode('manual')).toBe('default')
    for (const m of ['auto', 'acceptEdits', 'plan', 'bypassPermissions'] as const) expect(agentChatPermissionMode(m)).toBe(m)
  })
})

describe('buildAgentChatOptions', () => {
  test('always passes permissionMode; skip-permissions only for bypassPermissions', () => {
    const modes: AgentPermissionMode[] = ['manual', 'auto', 'acceptEdits', 'plan', 'bypassPermissions']
    for (const mode of modes) {
      const { options } = build({ mode })
      expect(options.permissionMode).toBe(agentChatPermissionMode(mode))
      expect(options.allowDangerouslySkipPermissions).toBe(mode === 'bypassPermissions' ? true : undefined)
    }
  })

  test('Claude may read this node\'s staged uploads (and only them) without a prompt', () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-chat-up-')) // test-only
    const { options } = build({ uploadsRoot: root })
    expect(options.additionalDirectories).toEqual([join(root, 'n-1')])
    expect(statSync(join(root, 'n-1')).isDirectory()).toBe(true)
    expect(build({ nodeId: 'n-2', uploadsRoot: root }).options.additionalDirectories).toEqual([join(root, 'n-2')])
  })

  test('loads the same setting layers, streams partials, sets cwd and resume only when given', () => {
    const { options, notice } = build({ resume: 'sess-9' })
    expect(options.settingSources).toEqual(AGENT_CHAT_SETTING_SOURCES)
    expect(options.settingSources).toEqual(['user', 'project', 'local'])
    expect(options.includePartialMessages).toBe(true)
    expect(options.cwd).toBe('/tmp/proj')
    expect(options.resume).toBe('sess-9')
    expect(notice).toBe(undefined)
    expect('resume' in build().options).toBe(false)
  })

  test('mirrors the terminal launch: node settings, house rules, explore plugin and MCP config files', () => {
    const { options } = build()
    expect(options.settings).toContain('node-settings')
    expect(options.plugins?.[0]?.type).toBe('local')
    expect(options.plugins?.[0]?.path).toContain('claude-plugin')
    expect(options.extraArgs?.['append-system-prompt-file']).toContain('house-rules')
    expect(typeof options.extraArgs?.['mcp-config']).toBe('string')
    // Files only: an inline JSON value would carry ':' that launch wrappers misread.
    expect(options.extraArgs?.['mcp-config']?.startsWith('{')).toBe(false)
  })

  test('file checkpointing on, with the replay-user-messages flag the docs require for rewind', () => {
    const { options } = build()
    expect(options.enableFileCheckpointing).toBe(true)
    expect(options.extraArgs?.['replay-user-messages']).toBe(null)
    expect(Object.keys(options.extraArgs ?? {})).toContain('replay-user-messages')
  })

  test('child env is the allowlisted parent plus node identity, with a temp CLAUDE_CONFIG_DIR', () => {
    const env = build({ parentEnv: { ...parentEnv, CLAUDECODE: '1' } }).options.env ?? {}
    expect(env.CLAUDE_CONFIG_DIR).toBe(configDir)
    expect(env.WEBTERM_NODE_ID).toBe('n-1')
    expect(env.CLAUDECODE).toBe(undefined)
  })

  test('spawn hook runs the envman profile argv with SDK args appended, o.env only, signal passed', () => {
    registerClaudeLaunchSettings(() => ({ ...DEFAULT_SETTINGS, claudeLaunchProfiles: [ENVMAN], defaultClaudeProfileId: 'em' }))
    const calls: Parameters<SpawnImpl>[] = []
    const fakeChild = {} as SpawnedProcess // test-only: the hook result is passed through untouched
    const spawn: SpawnImpl = (...a) => { calls.push(a); return fakeChild }
    const { options } = build({ profileId: 'em', spawn })
    expect(options.pathToClaudeCodeExecutable).toBe('claude')
    const signal = new AbortController().signal
    const o: SpawnOptions = { command: '/bundled/claude', args: ['--output-format=stream-json', '--verbose'], cwd: '/tmp/proj', env: { ONLY: 'this' }, signal }
    expect(options.spawnClaudeCodeProcess?.(o)).toBe(fakeChild)
    expect(calls).toEqual([['envman', ['-e', 'claude:work', '--', 'claude', '--output-format=stream-json', '--verbose'], { cwd: '/tmp/proj', env: { ONLY: 'this' }, stdio: 'pipe', signal }]])
  })

  test('default profile still sets pathToClaudeCodeExecutable', () => {
    expect(build().options.pathToClaudeCodeExecutable).toBe('claude')
  })

  test('a missing profile falls back and returns the missing-profile notice', () => {
    const { notice } = build({ profileId: 'gone' })
    expect(notice).toContain('Default')
    expect(notice?.startsWith('\r\n')).toBe(false)
  })

  test('a stale stored default id launches exactly like a terminal node carrying it: live profile, no notice', () => {
    registerClaudeLaunchSettings(() => ({ ...DEFAULT_SETTINGS, claudeLaunchProfiles: [ENVMAN], defaultClaudeProfileId: 'custom' }))
    registerDefaultProfileOverride(() => 'em')
    const calls: Parameters<SpawnImpl>[] = []
    const spawn: SpawnImpl = (...a) => { calls.push(a); return {} as SpawnedProcess } // test-only recorder
    const { options, notice } = build({ profileId: 'custom', spawn })
    expect(notice).toBe(undefined)
    options.spawnClaudeCodeProcess?.({ command: 'x', args: ['--verbose'], env: {}, signal: new AbortController().signal })
    expect(calls[0]?.[0]).toBe('envman')
    expect(calls[0]?.[1]).toEqual(['-e', 'claude:work', '--', 'claude', '--verbose'])
    const terminal = applyNodeClaudeProfile({ agentId: 'claude', cmd: 'claude', claudeProfileId: 'custom' })
    expect(terminal.msg.cmd).toBe('envman -e claude:work -- claude')
    expect(terminal.notice).toBe(undefined)
  })

  test('the hook drains child stderr to the caller (the SDK never reads it from a custom spawn)', async () => {
    const got: string[] = []
    const stderr = new PassThrough()
    const spawn: SpawnImpl = () => ({ stderr }) as unknown as SpawnedProcess // test-only child: stderr only
    const { options } = build({ spawn, stderr: (c) => got.push(c) })
    expect(options.stderr).toBe(undefined)
    options.spawnClaudeCodeProcess?.({ command: 'x', args: [], env: {}, signal: new AbortController().signal })
    stderr.end('oops')
    await new Promise((r) => setImmediate(r))
    expect(got).toEqual(['oops'])
  })
})

describe('createStderrTail', () => {
  test('keeps only the last max chars', () => {
    const t = createStderrTail(5)
    t.push('abc')
    t.push('defgh')
    expect(t.text()).toBe('defgh')
  })
})
