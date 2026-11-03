// Hook capability browser di `Sessions`: env hanya ada bila hook terpasang, dan dilepas saat close.
import { describe, expect, test, vi } from 'vitest'
import { Sessions, type SessionsOptions } from './sessions'
import { ptyEnv } from './ptyShell'
import { FakePty } from './fakePty.testutil'

type SpawnOpts = Parameters<NonNullable<SessionsOptions['spawn']>>[0]

function harness(browser?: SessionsOptions['browser']) {
  const spawns: SpawnOpts[] = []
  const sessions = new Sessions({ spawn: (o) => { spawns.push(o); return new FakePty(1) }, browser })
  return { sessions, spawns, env: (i: number) => ({ ...ptyEnv(process.env, { interactive: true }), ...(spawns[i].env ?? {}) }) }
}
const open = (id: string, agentId?: string) => ({ t: 'open' as const, id, cols: 80, rows: 24, ...(agentId ? { agentId } : {}) })

describe('sessions + browser capability hook', () => {
  test('hook env is merged into the spawn env of a new session', () => {
    const envFor = vi.fn(() => ({ WEBTERM_BROWSER_READ_CAP: 'r', WEBTERM_BROWSER_NODE_ID: 'b1' }))
    const { sessions, env } = harness({ envFor, release: vi.fn() })
    sessions.open(open('a1', 'claude'), () => undefined)
    expect(envFor).toHaveBeenCalledWith('a1', 'claude')
    expect(env(0).WEBTERM_BROWSER_READ_CAP).toBe('r')
    expect(env(0).WEBTERM_BROWSER_NODE_ID).toBe('b1')
  })

  test('re-attaching to a live session does not mint again; close releases', () => {
    const release = vi.fn()
    const envFor = vi.fn(() => ({}))
    const { sessions } = harness({ envFor, release })
    sessions.open(open('a1', 'claude'), () => undefined)
    sessions.open(open('a1', 'claude'), () => undefined)
    expect(envFor).toHaveBeenCalledTimes(1)
    sessions.close('a1')
    expect(release).toHaveBeenCalledWith('a1')
  })

  test('without a hook (flag off) no browser env exists and close is unchanged', () => {
    const { sessions, spawns, env } = harness()
    sessions.open(open('a1', 'claude'), () => undefined)
    expect(Object.keys(env(0)).filter((k) => k.startsWith('WEBTERM_BROWSER'))).toEqual([])
    expect(spawns).toHaveLength(1)
    expect(() => sessions.close('a1')).not.toThrow()
  })
})
