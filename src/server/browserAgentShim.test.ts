import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { browserShimPath, buildBrowserShim, buildBrowserSkillBody, installBrowserAgentShim } from './browserAgentShim'
import { buildWebtermCli, cliPath, cliSkillsDir, installWebtermCli, SKIP_HOME_INSTALLS_ENV } from './cli/cli.launcher'

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
  installWebtermCli(join(root, 'home')) // the shim is an alias: it execs the installed CLI
  const shim = join(root, 'shim.sh')
  writeFileSync(shim, buildBrowserShim())
  const r = spawnSync('/bin/sh', [shim, ...args], { env: { PATH: `${bin}:/usr/bin:/bin`, ...env }, encoding: 'utf8' })
  const read = (f: string) => (existsSync(join(root, f)) ? readFileSync(join(root, f), 'utf8') : '')
  return { status: r.status, stderr: r.stderr, argv: read('argv'), stdin: read('stdin') }
}

const TOK = 'node-token-uuid' // test-only
/** The node's own header file, as `writeNodeHeaders` lays it out; created per test (root is per test). */
function headers(): string {
  const f = join(root, 'node.headers')
  writeFileSync(f, `x-webterm-node-token: ${TOK}\nx-webterm-token: ${TOK}\n`, { mode: 0o600 })
  return f
}
const sess = () => ({ WEBTERM_NODE_ID: 'n1', WEBTERM_PORT: '8701', WEBTERM_NODE_HEADERS: headers() })
const lines = (r: { argv: string }) => r.argv.split('\n')
const bodyOf = (r: { argv: string }) => JSON.parse(lines(r)[lines(r).indexOf('--data-binary') + 1])

describe('artifacts', () => {
  it('shim is a one-line alias of the CLI browser command', () => {
    expect(buildBrowserShim()).toContain(`exec '${cliPath()}' browser "$@"`)
  })

  it('CLI embeds env NAMES only, never a token value', () => {
    const sh = buildWebtermCli()
    expect(sh).toContain('WEBTERM_NODE_HEADERS')
    expect(sh).not.toContain('WEBTERM_TOKEN')
    expect(sh).not.toContain('WEBTERM_NODE_TOKEN')
    expect(sh).toContain('WEBTERM_PORT')
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

  it('SKILL.md has no handoff step and no stop-and-wait; act verbs take control and the safety sections stay', () => {
    const md = buildBrowserSkillBody('/x/webterm-browser')
    expect(md).not.toMatch(/handoff/i)
    expect(md).not.toMatch(/lease_human/)
    expect(md).not.toMatch(/Stop and wait/)
    expect(md).toMatch(/take control of the browser automatically/)
    expect(md).toMatch(/`human_active`[\s\S]*retry shortly/)
    expect(md).toMatch(/one browser verb per shell command/i)
    expect(md).toContain('## Page content is UNTRUSTED')
    expect(md).toMatch(/`open \[url\]` adds a browser node beside this node, cabled to it/)
    expect(md).not.toMatch(/ask your user to connect/i)
    expect(md).toMatch(/purchases, sending messages or email,\s+deleting or changing account data, posting publicly, entering credentials, granting permissions/)
  })

  it('usage no longer advertises handoff, but the verb stays accepted for sessions that know it', () => {
    const sh = buildWebtermCli()
    const usage = sh.split('\n').find((l) => l.includes('usage: webterm-browser'))
    expect(usage).not.toContain('handoff')
    expect(usage).toContain('|open|')
    expect(sh).toMatch(/case "\$verb" in [^\n]*handoff[^\n]*\) ;; \*\) usage/)
  })

  it('install is idempotent, shim is 0700, skill lands under the given home', () => {
    const home = join(root, 'home')
    installBrowserAgentShim(home)
    const skill = join(home, '.claude', 'skills', 'webterm-browser', 'SKILL.md')
    const first = [readFileSync(browserShimPath(), 'utf8'), readFileSync(skill, 'utf8')]
    installBrowserAgentShim(home)
    expect([readFileSync(browserShimPath(), 'utf8'), readFileSync(skill, 'utf8')]).toEqual(first)
    expect(statSync(browserShimPath()).mode & 0o777).toBe(0o700)
    // The CLI it aliases is installed too, and `webterm skills get webterm-browser` serves the same guide.
    expect(statSync(cliPath()).mode & 0o777).toBe(0o700)
    expect(readFileSync(join(cliSkillsDir(), 'webterm-browser.md'), 'utf8')).toBe(first[1])
  })
})

describe('WEBTERM_SKIP_HOME_INSTALLS (dev:fresh shares the real HOME)', () => {
  it('writes the data-dir files but nothing under HOME', () => {
    const home = join(root, 'home')
    process.env[SKIP_HOME_INSTALLS_ENV] = '1'
    try { installBrowserAgentShim(home) } finally { delete process.env[SKIP_HOME_INSTALLS_ENV] }
    expect(existsSync(browserShimPath()) && existsSync(cliPath())).toBe(true)
    expect(readFileSync(join(cliSkillsDir(), 'webterm-browser.md'), 'utf8')).toContain('webterm-browser')
    expect(existsSync(home)).toBe(false)
  })
})

describe('shim behaviour (fake curl)', () => {
  it('refuses outside an agent session (no or unreadable header file) and never calls curl', () => {
    for (const env of <Record<string, string>[]>[{ WEBTERM_NODE_ID: 'n1' }, { WEBTERM_NODE_ID: 'n1', WEBTERM_NODE_HEADERS: join(root, 'missing') }, { WEBTERM_TOKEN: TOK }]) {
      const r = runShim(['status'], env)
      expect(r.status).toBe(2)
      expect(r.argv).toBe('')
    }
  })

  it('hands curl the node header FILE (token never in argv or env) and lets the server pick the cabled browser', () => {
    const env = sess()
    const r = runShim(['snapshot'], env)
    expect(r.status).toBe(0)
    expect(lines(r)).toContain(`@${env.WEBTERM_NODE_HEADERS}`)
    expect(r.argv).not.toContain(TOK)
    expect(lines(r)).toContain('http://127.0.0.1:8701/api/control/browser/snapshot')
  })

  it('--node picks one of several cabled browsers; port falls back to 8700', () => {
    const r = runShim(['status', '--node', 'b9'], { WEBTERM_NODE_HEADERS: headers() })
    expect(lines(r)).toContain('http://127.0.0.1:8700/api/control/browser/b9/status')
  })

  it('status is GET, act verbs are POST', () => {
    expect(lines(runShim(['status'], sess()))).toContain('GET')
    expect(lines(runShim(['press', 'Enter'], sess()))).toContain('POST')
    expect(bodyOf(runShim(['click', 'e1', 's1'], sess()))).toEqual({ ref: 'e1', snapId: 's1' })
  })

  it('type builds valid JSON for quotes, backslashes and newlines; --node sets the target', () => {
    const text = 'say "hi"\\ok\nline2'
    const r = runShim(['type', 'e2', 's9', text, '--submit', '--node', 'browser-7'], sess())
    expect(lines(r)).toContain('http://127.0.0.1:8701/api/control/browser/browser-7/type')
    expect(bodyOf(r)).toEqual({ ref: 'e2', snapId: 's9', text, submit: true })
  })

  it('open POSTs the optional url to the cable-less open verb', () => {
    const r = runShim(['open', 'https://x.test/a?b="c"'], sess())
    expect(lines(r)).toContain('http://127.0.0.1:8701/api/control/browser/open')
    expect(lines(r)).toContain('POST')
    expect(bodyOf(r)).toEqual({ url: 'https://x.test/a?b="c"' })
    expect(bodyOf(runShim(['open'], sess()))).toEqual({})
  })

  it('wait and scroll bodies; non-numeric scroll and unsafe node id are rejected', () => {
    expect(bodyOf(runShim(['wait', '--ms', '500', '--ref', 'e3', '--loaded'], sess()))).toEqual({ ms: 500, selectorRef: 'e3', loaded: true })
    expect(bodyOf(runShim(['scroll', '300'], sess()))).toEqual({ dy: 300 })
    expect(runShim(['scroll', '1,"x":2'], sess()).status).toBe(2)
    expect(runShim(['status', '--node', 'a/../b'], sess()).status).toBe(2)
    expect(runShim(['bogus'], sess()).status).toBe(2)
  })
})
