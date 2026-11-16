// Root-lock: the CLI retry watchdog reaches the Claude process on EVERY agent spawn path (PTY, headless exec,
// agent chat) without user config, and an explicit value is never overwritten. Fake spawns, no network.
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// db.ts-adjacent modules open the data dir: isolate it and HOME so nothing touches the user's real one.
const DIR = mkdtempSync(join(tmpdir(), 'webterm-watchdog-'))
process.env.WEBTERM_DATA_DIR = DIR
const ORIGINAL_HOME = process.env.HOME
process.env.HOME = DIR
afterAll(() => {
  process.env.HOME = ORIGINAL_HOME
  rmSync(DIR, { recursive: true, force: true })
})

import { agentChatEnv } from './agentChat/agentChat.env'
import { retryWatchdogEnv, RETRY_WATCHDOG_VAR, scrubAgentEnv } from './agentEnv'
import { scrubExecEnv } from './central/agents/execRunner'
import type { Pty } from './pty'
import { Sessions } from './sessions'

const NO_PROVIDER = { set: {}, unset: [] }

function ptyEnvFor(agentId: 'claude' | 'codex' | undefined, processEnv?: string): Record<string, string> | undefined {
  const saved = process.env[RETRY_WATCHDOG_VAR]
  if (processEnv === undefined) delete process.env[RETRY_WATCHDOG_VAR]
  else process.env[RETRY_WATCHDOG_VAR] = processEnv
  try {
    let seen: Record<string, string> | undefined
    const fake = (o: { env?: Record<string, string> }): Pty => {
      seen = o.env
      return { pid: 1, onData() {}, onExit() {}, write() {}, resize() {}, kill() {} }
    }
    const s = new Sessions({ spawn: fake as never }, null)
    s.open({ t: 'open', id: 'w1', cols: 80, rows: 24, cmd: agentId ?? 'sh', ...(agentId ? { agentId } : {}) }, () => {})
    s.close('w1')
    return seen
  } finally {
    if (saved === undefined) delete process.env[RETRY_WATCHDOG_VAR]
    else process.env[RETRY_WATCHDOG_VAR] = saved
  }
}

describe('retry watchdog on every spawn path', () => {
  test('PTY claude node gets it by default; explicit 0 is kept; plain terminal and non-claude agent get none', () => {
    expect(ptyEnvFor('claude')?.[RETRY_WATCHDOG_VAR]).toBe('1')
    expect(ptyEnvFor('claude', '0')?.[RETRY_WATCHDOG_VAR]).toBe('0')
    expect(ptyEnvFor(undefined)?.[RETRY_WATCHDOG_VAR] === undefined).toBe(true)
    expect(ptyEnvFor('codex')?.[RETRY_WATCHDOG_VAR] === undefined).toBe(true)
  })

  test('headless exec: default on, explicit value kept, and an override still wins last', () => {
    expect(scrubExecEnv({ PATH: '/bin' })[RETRY_WATCHDOG_VAR]).toBe('1')
    expect(scrubExecEnv({ PATH: '/bin', [RETRY_WATCHDOG_VAR]: '0' })[RETRY_WATCHDOG_VAR]).toBe('0')
    expect(scrubExecEnv({ PATH: '/bin' }, { [RETRY_WATCHDOG_VAR]: '0' })[RETRY_WATCHDOG_VAR]).toBe('0')
  })

  test('agent chat: default on, explicit server value and profile env win', () => {
    const base = { PATH: '/usr/bin', HOME: '/home/test' }
    expect(agentChatEnv({ nodeId: 'n', port: 1, parentEnv: base, provider: NO_PROVIDER })[RETRY_WATCHDOG_VAR]).toBe('1')
    expect(agentChatEnv({ nodeId: 'n', port: 1, parentEnv: { ...base, [RETRY_WATCHDOG_VAR]: '0' }, provider: NO_PROVIDER })[RETRY_WATCHDOG_VAR]).toBe('0')
    expect(agentChatEnv({ nodeId: 'n', port: 1, parentEnv: base, provider: NO_PROVIDER, profileEnv: { [RETRY_WATCHDOG_VAR]: '0' } })[RETRY_WATCHDOG_VAR]).toBe('0')
  })

  test('the var leaks no secret: it is the only addition on a bare env', () => {
    expect(retryWatchdogEnv({})).toEqual({ [RETRY_WATCHDOG_VAR]: '1' })
    expect(scrubAgentEnv({ PATH: '/bin', WEBTERM_TOKEN: 'root-test-only' })).toEqual({ PATH: '/bin', [RETRY_WATCHDOG_VAR]: '1' })
  })
})
