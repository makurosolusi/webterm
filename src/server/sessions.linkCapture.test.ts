// Every terminal session (plain shell AND agent) carries the link catcher: BROWSER, the shim dir first on PATH,
// the port; plain shells also the limited link header path (never a token). The switch and the browser feature gate it.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Sessions } from './sessions'
import { FakePty } from './fakePty.testutil'
import { ENV_CAPTURE_LINKS, LINK_HEADERS_ENV } from './linkCapture/linkCapture.config'
import { linkHeadersPath } from './linkCapture/linkCapture.identity'
import { cliPath } from './cli/cli.launcher'

process.env.WEBTERM_DATA_DIR = mkdtempSync(join(tmpdir(), 'wt-sesscap-'))
const BIN = dirname(cliPath())
let spawned: Array<{ env?: Record<string, string>; cmd?: string }>
const saved = { ...process.env }

function sessions(linkCapture = true): Sessions {
  return new Sessions({ linkCapture, shell: '/bin/zsh', spawn: ((o: { env?: Record<string, string>; cmd?: string }) => { spawned.push({ env: o.env, cmd: o.cmd }); return new FakePty() }) as never })
}
const open = (s: Sessions, id: string, extra: object = {}) => s.handle({ t: 'open', id, cols: 80, rows: 24, ...extra } as never, () => {})

beforeEach(() => { spawned = []; delete process.env[ENV_CAPTURE_LINKS]; process.env.WEBTERM_BROWSER = 'on' })
afterEach(() => { process.env = { ...saved } })

describe('session env for link capture', () => {
  it('a plain terminal gets BROWSER, the shim dir first on PATH, the port and the limited link header path', () => {
    open(sessions(), 'term1')
    const env = spawned[0].env ?? {}
    expect(env.BROWSER).toBe(join(BIN, 'webterm-open'))
    expect(env.PATH?.split(':')[0]).toBe(BIN)
    expect(env.WEBTERM_PORT).toBeDefined()
    expect(env[LINK_HEADERS_ENV]).toBe(linkHeadersPath('term1'))
  })

  it('a plain terminal still holds no node token: no node header file, no token env, no token in any value', () => {
    open(sessions(), 'term1')
    const env = spawned[0].env ?? {}
    expect(Object.keys(env)).not.toContain('WEBTERM_NODE_HEADERS')
    expect(Object.keys(env)).not.toContain('WEBTERM_NODE_TOKEN')
    expect(Object.values(env).join('\n')).not.toMatch(/[0-9a-f]{32}/) // no mac / token value in env: only paths
  })

  it('an interactive zsh also gets the ZDOTDIR hook; a command launch gets the PATH prefix instead', () => {
    open(sessions(), 'term1')
    expect(spawned[0].env?.ZDOTDIR).toContain(join('shell', 'zsh'))
    open(sessions(), 'cmd1', { cmd: 'htop' })
    expect(spawned[1].env?.ZDOTDIR).toBeUndefined()
    expect(spawned[1].cmd).toBe(`PATH='${BIN}':"$PATH"; export PATH; htop`)
  })

  it('an agent session gets the catcher too, and keeps its own node header file instead of a link header', () => {
    open(sessions(), 'agent1', { agentId: 'claude', cmd: 'claude' })
    const env = spawned[0].env ?? {}
    expect(env.BROWSER).toBe(join(BIN, 'webterm-open'))
    expect(env.PATH?.split(':')[0]).toBe(BIN)
    expect(env[LINK_HEADERS_ENV]).toBeUndefined()
    expect(env.WEBTERM_NODE_HEADERS).toBeDefined()
  })

  it('the Settings switch off: new sessions get none of it', () => {
    process.env[ENV_CAPTURE_LINKS] = 'off'
    open(sessions(), 'term1')
    open(sessions(), 'cmd1', { cmd: 'htop' })
    expect(spawned[0].env?.BROWSER).toBeUndefined()
    expect(spawned[0].env?.ZDOTDIR).toBeUndefined()
    expect(spawned[1].cmd).toBe('htop')
  })

  it('the browser feature off: nothing to capture into, so no shims are put in front', () => {
    process.env.WEBTERM_BROWSER = 'off'
    open(sessions(), 'term1')
    expect(spawned[0].env?.BROWSER).toBeUndefined()
  })

  it('an injected test spawn is left alone unless capture is asked for', () => {
    open(sessions(false), 'term1')
    expect(spawned[0].env).toBeUndefined()
  })
})
