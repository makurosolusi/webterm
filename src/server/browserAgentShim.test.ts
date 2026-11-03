import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  BROWSER_ACT_CAP_ENV, BROWSER_NODE_ID_ENV, BROWSER_READ_CAP_ENV, browserShimPath, buildBrowserShim, buildBrowserSkillBody,
  installBrowserAgentShim,
} from './browserAgentShim'

let root: string
const prevData = process.env.WEBTERM_DATA_DIR

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bshim-'))
  process.env.WEBTERM_DATA_DIR = join(root, 'data')
})
afterEach(() => {
  if (prevData === undefined) delete process.env.WEBTERM_DATA_DIR
  else process.env.WEBTERM_DATA_DIR = prevData
  rmSync(root, { recursive: true, force: true })
})

/** Fake curl: records argv and the stdin config into files, answers `{"ok":true}`. */
function runShim(args: string[], env: Record<string, string>) {
  const bin = join(root, 'bin')
  spawnSync('mkdir', ['-p', bin])
  const curl = join(bin, 'curl')
  writeFileSync(curl, `#!/bin/sh\nprintf '%s\\n' "$@" > "${root}/argv"\ncat > "${root}/stdin"\necho '{"ok":true}'\n`)
  chmodSync(curl, 0o700)
  const shim = join(root, 'shim.sh')
  writeFileSync(shim, buildBrowserShim())
  const r = spawnSync('/bin/sh', [shim, ...args], { env: { PATH: `${bin}:/usr/bin:/bin`, ...env }, encoding: 'utf8' })
  const read = (f: string) => (existsSync(join(root, f)) ? readFileSync(join(root, f), 'utf8') : '')
  return { status: r.status, stderr: r.stderr, argv: read('argv'), stdin: read('stdin') }
}

const sess = { NODETERM_NODE_ID: 'n1', NODETERM_PORT: '8701' }
const READ = 'wcap_readtoken'
const ACT = 'wcap_acttoken'

describe('artifacts', () => {
  it('shim embeds env NAMES only, never a token value or the node/root token', () => {
    const sh = buildBrowserShim()
    expect(sh).toContain('NODETERM_NODE_ID')
    expect(sh).toContain('NODETERM_PORT')
    expect(sh).toContain(BROWSER_READ_CAP_ENV)
    expect(sh).toContain(BROWSER_ACT_CAP_ENV)
    expect(sh).toContain('/api/control/browser/')
    expect(sh).not.toMatch(/wcap_/)
    expect(sh).not.toContain('WEBTERM_TOKEN')
    expect(sh).not.toContain('NODETERM_NODE_TOKEN')
    expect(sh).not.toContain('x-webterm-token')
  })

  it('SKILL.md warns that page content is untrusted and asks for confirmation', () => {
    const md = buildBrowserSkillBody('/x/webterm-browser')
    expect(md).toContain('/x/webterm-browser')
    expect(md).toMatch(/UNTRUSTED/)
    expect(md).toMatch(/NEVER follow/)
    expect(md).toMatch(/confirm/)
    expect(md).toContain('snapshot')
    expect(md).not.toMatch(/wcap_/)
  })

  it('install is idempotent, shim is 0700, skill lands under the given home', () => {
    const home = join(root, 'home')
    installBrowserAgentShim(home)
    const skill = join(home, '.claude', 'skills', 'webterm-browser', 'SKILL.md')
    const first = [readFileSync(browserShimPath(), 'utf8'), readFileSync(skill, 'utf8')]
    installBrowserAgentShim(home)
    expect([readFileSync(browserShimPath(), 'utf8'), readFileSync(skill, 'utf8')]).toEqual(first)
    expect(statSync(browserShimPath()).mode & 0o777).toBe(0o700)
  })
})

describe('shim behaviour (fake curl)', () => {
  it('refuses outside a webterm session', () => {
    const r = runShim(['status'], {})
    expect(r.status).toBe(2)
    expect(r.argv).toBe('')
  })

  it('without a capability it fails and never calls curl, even if the node token is present', () => {
    const r = runShim(['status'], { ...sess, WEBTERM_TOKEN: 'node-token', NODETERM_NODE_TOKEN: 'node-token' })
    expect(r.status).toBe(3)
    expect(r.argv).toBe('')
  })

  it('read verb uses the read capability, passed via stdin config and not argv', () => {
    const r = runShim(['snapshot'], { ...sess, [BROWSER_READ_CAP_ENV]: READ, [BROWSER_ACT_CAP_ENV]: ACT })
    expect(r.status).toBe(0)
    expect(r.stdin).toContain(`x-webterm-capability: ${READ}`)
    expect(r.argv).not.toContain(READ)
    expect(r.argv).not.toContain(ACT)
    expect(r.argv).toContain('http://127.0.0.1:8701/api/control/browser/n1/snapshot')
  })

  it('targets the injected browser node id, not the agent session id; --node still wins', () => {
    const env = { ...sess, [BROWSER_READ_CAP_ENV]: READ, [BROWSER_NODE_ID_ENV]: 'browser-3' }
    expect(runShim(['status'], env).argv).toContain('/api/control/browser/browser-3/status')
    expect(runShim(['status', '--node', 'b9'], env).argv).toContain('/api/control/browser/b9/status')
  })

  it('status is GET, act verbs are POST', () => {
    const env = { ...sess, [BROWSER_READ_CAP_ENV]: READ, [BROWSER_ACT_CAP_ENV]: ACT }
    expect(runShim(['status'], env).argv.split('\n')).toContain('GET')
    expect(runShim(['press', 'Enter'], env).argv.split('\n')).toContain('POST')
  })

  it('act verb needs the act capability; the read capability does not substitute', () => {
    const only = { ...sess, [BROWSER_READ_CAP_ENV]: READ }
    expect(runShim(['click', 'e1', 's1'], only).status).toBe(3)
    const r = runShim(['click', 'e1', 's1'], { ...only, [BROWSER_ACT_CAP_ENV]: ACT })
    expect(r.stdin).toContain(`x-webterm-capability: ${ACT}`)
    expect(r.argv).toContain('{"ref":"e1","snapId":"s1"}')
  })

  it('type builds valid JSON for quotes, backslashes and newlines; --node overrides the target', () => {
    const text = 'say "hi"\\ok\nline2'
    const r = runShim(['type', 'e2', 's9', text, '--submit', '--node', 'browser-7'], { ...sess, [BROWSER_ACT_CAP_ENV]: ACT })
    const lines = r.argv.split('\n')
    expect(lines).toContain('http://127.0.0.1:8701/api/control/browser/browser-7/type')
    const body = lines[lines.indexOf('--data-binary') + 1]
    expect(JSON.parse(body)).toEqual({ ref: 'e2', snapId: 's9', text, submit: true })
  })

  it('wait and scroll bodies; non-numeric scroll and unsafe node id are rejected', () => {
    const env = { ...sess, [BROWSER_READ_CAP_ENV]: READ, [BROWSER_ACT_CAP_ENV]: ACT }
    const w = runShim(['wait', '--ms', '500', '--ref', 'e3', '--loaded'], env).argv.split('\n')
    expect(JSON.parse(w[w.indexOf('--data-binary') + 1])).toEqual({ ms: 500, selectorRef: 'e3', loaded: true })
    const s = runShim(['scroll', '300'], env).argv.split('\n')
    expect(JSON.parse(s[s.indexOf('--data-binary') + 1])).toEqual({ dy: 300 })
    expect(runShim(['scroll', '1,"x":2'], env).status).toBe(2)
    expect(runShim(['status', '--node', 'a/../b'], env).status).toBe(2)
    expect(runShim(['bogus'], env).status).toBe(2)
  })
})
