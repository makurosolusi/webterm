import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { browserShimPath, buildBrowserShim, buildBrowserSkillBody, installBrowserAgentShim } from './browserAgentShim'

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

const TOK = 'node-token-uuid' // test-only
const sess = { NODETERM_NODE_ID: 'n1', NODETERM_PORT: '8701', WEBTERM_TOKEN: TOK }
const lines = (r: { argv: string }) => r.argv.split('\n')
const bodyOf = (r: { argv: string }) => JSON.parse(lines(r)[lines(r).indexOf('--data-binary') + 1])

describe('artifacts', () => {
  it('shim embeds env NAMES only, never a token value', () => {
    const sh = buildBrowserShim()
    expect(sh).toContain('WEBTERM_TOKEN')
    expect(sh).toContain('NODETERM_NODE_TOKEN')
    expect(sh).toContain('NODETERM_PORT')
    expect(sh).toContain('/api/control/browser/')
    expect(sh).not.toMatch(/wcap_/)
    expect(sh).not.toContain('WEBTERM_BROWSER_READ_CAP')
  })

  it('SKILL.md says the target is the browser linked by a cable, and warns page content is untrusted', () => {
    const md = buildBrowserSkillBody('/x/webterm-browser')
    expect(md).toContain('/x/webterm-browser')
    expect(md).toMatch(/^description: .*linked by a cable/m)
    expect(md).toMatch(/no restart/)
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
  it('refuses outside an agent session (no node token) and never calls curl', () => {
    const r = runShim(['status'], { NODETERM_NODE_ID: 'n1' })
    expect(r.status).toBe(2)
    expect(r.argv).toBe('')
  })

  it('sends the node token via stdin config (not argv) and lets the server pick the cabled browser', () => {
    const r = runShim(['snapshot'], sess)
    expect(r.status).toBe(0)
    expect(r.stdin).toContain(`x-webterm-token: ${TOK}`)
    expect(r.argv).not.toContain(TOK)
    expect(lines(r)).toContain('http://127.0.0.1:8701/api/control/browser/snapshot')
  })

  it('falls back to NODETERM_NODE_TOKEN; --node picks one of several cabled browsers', () => {
    const r = runShim(['status', '--node', 'b9'], { NODETERM_NODE_TOKEN: 'hook-tok' })
    expect(r.stdin).toContain('x-webterm-token: hook-tok')
    expect(lines(r)).toContain('http://127.0.0.1:8700/api/control/browser/b9/status')
  })

  it('status is GET, act verbs are POST', () => {
    expect(lines(runShim(['status'], sess))).toContain('GET')
    expect(lines(runShim(['press', 'Enter'], sess))).toContain('POST')
    expect(bodyOf(runShim(['click', 'e1', 's1'], sess))).toEqual({ ref: 'e1', snapId: 's1' })
  })

  it('type builds valid JSON for quotes, backslashes and newlines; --node sets the target', () => {
    const text = 'say "hi"\\ok\nline2'
    const r = runShim(['type', 'e2', 's9', text, '--submit', '--node', 'browser-7'], sess)
    expect(lines(r)).toContain('http://127.0.0.1:8701/api/control/browser/browser-7/type')
    expect(bodyOf(r)).toEqual({ ref: 'e2', snapId: 's9', text, submit: true })
  })

  it('wait and scroll bodies; non-numeric scroll and unsafe node id are rejected', () => {
    expect(bodyOf(runShim(['wait', '--ms', '500', '--ref', 'e3', '--loaded'], sess))).toEqual({ ms: 500, selectorRef: 'e3', loaded: true })
    expect(bodyOf(runShim(['scroll', '300'], sess))).toEqual({ dy: 300 })
    expect(runShim(['scroll', '1,"x":2'], sess).status).toBe(2)
    expect(runShim(['status', '--node', 'a/../b'], sess).status).toBe(2)
    expect(runShim(['bogus'], sess).status).toBe(2)
  })
})
