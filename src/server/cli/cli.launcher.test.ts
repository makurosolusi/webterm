import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { browserShimPath, installBrowserAgentShim } from '../browserAgentShim'
import { buildContextShim } from '../contextLinkSkill'
import { snapshotOf } from './cli.registry'
import { buildCliGuide, buildCliSkillStub, buildWebtermCli, CLI_SKILL_NAME, cliGuideVersion, cliPath, cliSkillsDir, installWebtermCli } from './cli.launcher'

let root: string
const prevData = process.env.WEBTERM_DATA_DIR
const TOK = 'node-token-for-cli-tests' // test-only

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wcli-'))
  process.env.WEBTERM_DATA_DIR = join(root, 'data')
})
afterEach(() => {
  if (prevData === undefined) delete process.env.WEBTERM_DATA_DIR
  else process.env.WEBTERM_DATA_DIR = prevData
  rmSync(root, { recursive: true, force: true })
})

const home = () => join(root, 'home')
function headers(): string {
  const f = join(root, 'node.headers')
  writeFileSync(f, `x-webterm-node-token: ${TOK}\n`, { mode: 0o600 })
  return f
}

/** Runs the installed CLI (or `script`) with a fake curl that records argv and answers `body` + status. */
function run(args: string[], env: Record<string, string>, opts: { status?: number; script?: string } = {}) {
  const bin = join(root, 'fakebin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'curl'), `#!/bin/sh\nprintf '%s\\n' "$@" > "${root}/argv"\nprintf '{"receipt":{"outcome":"x"}}\\n${opts.status ?? 200}'\n`)
  chmodSync(join(bin, 'curl'), 0o700)
  rmSync(join(root, 'argv'), { force: true })
  const r = spawnSync(opts.script ?? cliPath(), args, { env: { PATH: `${bin}:/usr/bin:/bin`, ...env }, encoding: 'utf8' })
  const argv = existsSync(join(root, 'argv')) ? readFileSync(join(root, 'argv'), 'utf8').split('\n') : []
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, argv }
}

describe('install', () => {
  it('writes a 0700 launcher in the webterm bin dir, the guide, and a stub skill; idempotent', () => {
    installWebtermCli(home())
    const stub = join(home(), '.claude', 'skills', CLI_SKILL_NAME, 'SKILL.md')
    const first = [readFileSync(cliPath(), 'utf8'), readFileSync(stub, 'utf8')]
    installWebtermCli(home())
    expect([readFileSync(cliPath(), 'utf8'), readFileSync(stub, 'utf8')]).toEqual(first)
    expect(cliPath()).toBe(join(root, 'data', 'bin', 'webterm'))
    expect(statSync(cliPath()).mode & 0o777).toBe(0o700)
    expect(spawnSync('sh', ['-n', cliPath()]).status).toBe(0)
  })

  it('the stub only points at the version-matched guide (Orca skill-stub pattern)', () => {
    const stub = buildCliSkillStub('/x/webterm')
    expect(stub).toMatch(/^---\nname: webterm-cli\ndescription: /)
    expect(stub).toContain('/x/webterm skills get webterm-cli')
    expect(stub).not.toContain('agent-context --json') // the guide carries the instructions, not the stub
  })

  it('the guide is versioned by the registry content hash and lists every capability', () => {
    const guide = buildCliGuide('/x/webterm')
    expect(cliGuideVersion()).toBe(snapshotOf().version)
    expect(guide).toContain(`\nversion: ${cliGuideVersion()}\n`)
    for (const c of snapshotOf().capabilities) expect(guide).toContain(`\`${c.name}\``)
  })

  it('help and the version-matched guide teach the skills verbs, and say a human approves', () => {
    installWebtermCli(home())
    const help = run(['help'], {}).stdout
    for (const verb of ['skills list', 'skills propose', 'skills edit']) expect(help).toContain(verb)
    const guide = buildCliGuide('/x/webterm')
    expect(guide).toContain('skills propose --name webterm-<slug>')
    expect(guide).toContain('a human approves it in webterm')
    expect(run(['skills'], {}).status).toBe(2) // bare `skills` = usage, not a crash
    expect(run(['skills', 'approve', 'webterm-x'], {}).stderr).toContain('usage: webterm skills')
  })

  it('tells agents how to show an MCP Apps ui:// view (webterm MCP tool app_open)', () => {
    expect(buildCliGuide('/x/webterm')).toMatch(/_meta\.ui\.resourceUri.*`app_open`/)
  })

  it('carries no token value and no token env name', () => {
    const sh = buildWebtermCli()
    expect(sh).not.toMatch(/WEBTERM_TOKEN|WEBTERM_NODE_TOKEN|wcap_/)
    expect(sh).toContain('-H "@$hdr"')
  })
})

describe('skills get (reads the bundled guide, never the server)', () => {
  it('prints the guide; --json adds name and version; unknown names list what exists', () => {
    installWebtermCli(home())
    const text = run(['skills', 'get', 'webterm-cli'], {})
    expect(text.status).toBe(0)
    expect(text.stdout).toBe(readFileSync(join(cliSkillsDir(), 'webterm-cli.md'), 'utf8'))
    expect(text.argv).toEqual([]) // no curl
    const json = JSON.parse(run(['skills', 'get', 'webterm-cli', '--json'], {}).stdout)
    expect(json).toMatchObject({ name: 'webterm-cli', version: cliGuideVersion() })
    expect(json.markdown).toContain('# webterm CLI')
    const unknown = run(['skills', 'get', 'nope'], {})
    expect(unknown.status).toBe(2)
    expect(unknown.stderr).toContain('webterm-cli')
    expect(run(['skills', 'get', '../etc'], {}).status).toBe(2)
  })

  it('a new registry version rewrites the guide the stub points at', () => {
    installWebtermCli(home())
    const f = join(cliSkillsDir(), 'webterm-cli.md')
    writeFileSync(f, readFileSync(f, 'utf8').replace(/^version: .*$/m, 'version: 000000000000'))
    installWebtermCli(home()) // next boot
    expect(JSON.parse(run(['skills', 'get', 'webterm-cli', '--json'], {}).stdout).version).toBe(cliGuideVersion())
  })
})

describe('capability calls and discovery (fake curl)', () => {
  it('POSTs the JSON to /api/tools/<name> with the header FILE; the token never reaches argv', () => {
    installWebtermCli(home())
    const hdr = headers()
    const r = run(['git.diff', '--json', '{"root":"/repo"}', '--operation-id', 'op-1'], { WEBTERM_NODE_HEADERS: hdr, WEBTERM_PORT: '8701' })
    expect(r.status).toBe(0)
    expect(r.argv).toContain(`@${hdr}`)
    expect(r.argv).toContain('http://127.0.0.1:8701/api/tools/git.diff?operationId=op-1')
    expect(r.argv[r.argv.indexOf('--data-binary') + 1]).toBe('{"root":"/repo"}')
    expect(r.argv.join('\n')).not.toContain(TOK)
  })

  it('legacy: a pre-rename session (only NODETERM_PORT set) still reaches the right port', () => {
    installWebtermCli(home())
    const r = run(['git.diff', '--json', '{"root":"/repo"}'], { WEBTERM_NODE_HEADERS: headers(), NODETERM_PORT: '8702' })
    expect(r.status).toBe(0)
    expect(r.argv.some((a) => a.startsWith('http://127.0.0.1:8702/api/tools/git.diff'))).toBe(true)
    const fresh = run(['git.diff', '--json', '{"root":"/repo"}'], { WEBTERM_NODE_HEADERS: headers(), WEBTERM_PORT: '8703', NODETERM_PORT: '8702' })
    expect(fresh.argv.some((a) => a.startsWith('http://127.0.0.1:8703/'))).toBe(true) // new name wins
    expect(r.stdout).toBe('{"receipt":{"outcome":"x"}}\n')
  })

  it('a non-2xx answer exits 1; no session, a bad name or a bad operation id exit 2 without calling curl', () => {
    installWebtermCli(home())
    expect(run(['node.close', '--json', '{}'], { WEBTERM_NODE_HEADERS: headers() }, { status: 403 }).status).toBe(1)
    for (const [args, env] of [
      [['git.diff'], {}],
      [['git.diff'], { WEBTERM_NODE_HEADERS: join(root, 'missing') }],
      [['../x'], { WEBTERM_NODE_HEADERS: headers() }],
      [['git.diff', '--operation-id', 'a b'], { WEBTERM_NODE_HEADERS: headers() }],
    ] as [string[], Record<string, string>][]) {
      const r = run(args, env)
      expect(r.status).toBe(2)
      expect(r.argv).toEqual([])
    }
  })

  it('agent-context and whats-new hit the discovery routes, JSON only with --json', () => {
    installWebtermCli(home())
    const env = { WEBTERM_NODE_HEADERS: headers() }
    const json = run(['agent-context', '--json'], env)
    expect(json.argv).toContain('http://127.0.0.1:8700/api/tools')
    expect(json.argv).toContain('accept: application/json')
    expect(run(['agent-context'], env).argv).toContain('accept: text/plain')
    expect(run(['whats-new', '--since', 'abcdef012345', '--json'], env).argv).toContain('http://127.0.0.1:8700/api/tools/whats-new?since=abcdef012345')
    expect(run(['whats-new', '--since', 'x;y'], env).status).toBe(2)
  })
})

describe('old shims are aliases that still work', () => {
  it('webterm-browser <verb> reaches the browser control route through the CLI', () => {
    installBrowserAgentShim(home())
    const r = run(['snapshot', '--node', 'b9'], { WEBTERM_NODE_HEADERS: headers() }, { script: browserShimPath() })
    expect(r.status).toBe(0)
    expect(r.argv).toContain('http://127.0.0.1:8700/api/control/browser/b9/snapshot')
    expect(r.argv.join('\n')).not.toContain(TOK)
  })

  it('webterm browser open --profile <name> [url] sends the profile in the body (navigate too); `profiles` is a GET', () => {
    installWebtermCli(home())
    const env = { WEBTERM_NODE_HEADERS: headers() }
    const open = run(['browser', 'open', '--profile', 'work', 'https://example.com'], env)
    expect(open.status).toBe(0)
    expect(open.argv).toContain('http://127.0.0.1:8700/api/control/browser/open')
    expect(open.argv).toContain('{"url":"https://example.com","profile":"work"}')
    expect(run(['browser', 'open', '--profile', 'Sales Team'], env).argv).toContain('{"profile":"Sales Team"}')
    expect(run(['browser', 'open', 'https://example.com'], env).argv).toContain('{"url":"https://example.com"}')
    expect(run(['browser', 'open'], env).argv).toContain('{}')
    expect(run(['browser', 'navigate', '--profile', 'work', 'https://example.com'], env).argv).toContain('{"url":"https://example.com","profile":"work"}')
    const list = run(['browser', 'profiles'], env)
    expect(list.argv).toContain('http://127.0.0.1:8700/api/control/browser/profiles')
    expect(list.argv).toEqual(expect.arrayContaining(['-X', 'GET']))
  })

  it('--profile is refused for any verb but open and navigate, and needs a value', () => {
    installWebtermCli(home())
    const env = { WEBTERM_NODE_HEADERS: headers() }
    expect(run(['browser', 'snapshot', '--profile', 'work'], env).status).toBe(2)
    expect(run(['browser', 'open', '--profile'], env).status).toBe(2)
    expect(run(['browser', 'snapshot', '--profile', 'work'], env).argv).toEqual([]) // no request left the machine
  })

  it('webterm browser tabs / tab new|switch|close / --tab send the tab bodies to the control route', () => {
    installWebtermCli(home())
    const env = { WEBTERM_NODE_HEADERS: headers() }
    const url = (verb: string) => `http://127.0.0.1:8700/api/control/browser/${verb}`
    const tabs = run(['browser', 'tabs'], env)
    expect(tabs.status).toBe(0)
    expect(tabs.argv).toContain(url('tabs'))
    expect(run(['browser', 'tab', 'new', 'https://example.com/b'], env).argv).toContain('{"action":"new","url":"https://example.com/b"}')
    expect(run(['browser', 'tab', 'new'], env).argv).toContain('{"action":"new"}')
    expect(run(['browser', 'tab', 'switch', 't2'], env).argv).toContain('{"action":"switch","tab":"t2"}')
    expect(run(['browser', 'tab', 'close', 't2'], env).argv).toContain('{"action":"close","tab":"t2"}')
    // --tab joins the verb's own body, and a body-less verb gets just the tab
    expect(run(['browser', 'snapshot', '--tab', 't3'], env).argv).toContain('{"tab":"t3"}')
    expect(run(['browser', 'click', 'e5', 's2', '--tab', 't3'], env).argv).toContain('{"ref":"e5","snapId":"s2","tab":"t3"}')
    expect(run(['browser', 'navigate', 'https://example.com/', '--tab', 't3'], env).argv).toContain('{"url":"https://example.com/","tab":"t3"}')
    const status = run(['browser', 'status', '--tab', 't3'], env)
    expect(status.argv).toEqual(expect.arrayContaining(['-X', 'POST', '{"tab":"t3"}'])) // a GET would drop the body
  })

  it('webterm browser downloads posts an empty body to the downloads verb, takes --node, and rejects --tab/--all', () => {
    installWebtermCli(home())
    const env = { WEBTERM_NODE_HEADERS: headers() }
    const url = 'http://127.0.0.1:8700/api/control/browser/downloads'
    const r = run(['browser', 'downloads'], env)
    expect(r.status).toBe(0)
    expect(r.argv).toContain(url)
    expect(r.argv).toContain('{}')
    expect(run(['browser', 'downloads', '--node', 'b1'], env).argv).toContain('http://127.0.0.1:8700/api/control/browser/b1/downloads')
    for (const args of [['downloads', '--tab', 't2'], ['downloads', '--all']]) {
      const bad = run(['browser', ...args], env)
      expect([args, bad.status]).toEqual([args, 2])
      expect(bad.argv).toEqual([])
    }
    expect(run(['browser'], env).stderr).toContain('downloads')
  })

  it('--tab and the tab verbs refuse bad input before any request leaves the machine', () => {
    installWebtermCli(home())
    const env = { WEBTERM_NODE_HEADERS: headers() }
    for (const args of [['open', '--tab', 't2'], ['tab', 'new', '--tab', 't2'], ['tabs', '--tab', 't2'], ['snapshot', '--tab', 't2;rm'], ['snapshot', '--tab'], ['tab', 'switch'], ['tab', 'close'], ['tab', 'explode', 't2'], ['tab']]) {
      const r = run(['browser', ...args], env)
      expect([args, r.status]).toEqual([args, 2])
      expect(r.argv).toEqual([])
    }
  })

  it('webterm browser layout get|set, sync, reload/back/forward and --all build the right verb and body', () => {
    installWebtermCli(home())
    const env = { WEBTERM_NODE_HEADERS: headers() }
    const url = (verb: string) => `http://127.0.0.1:8700/api/control/browser/${verb}`
    const get = run(['browser', 'layout', 'get'], env)
    expect(get.argv).toContain(url('layout'))
    expect(run(['browser', 'layout'], env).argv).toContain(url('layout'))
    const set = run(['browser', 'layout', 'set', 'h', 't1', 'new:https://b.test/x'], env)
    expect(set.argv).toContain(url('arrange'))
    expect(set.argv).toContain('{"spec":"h t1 new:https://b.test/x"}')
    expect(run(['browser', 'layout', 'set', 'grid', 't1', 't2', 't3', 't4'], env).argv).toContain('{"spec":"grid t1 t2 t3 t4"}')
    expect(run(['browser', 'layout', 'set', 'single', 't1'], env).argv).toContain('{"spec":"single t1"}')
    expect(run(['browser', 'sync', 'on'], env).argv).toContain('{"on":true}')
    expect(run(['browser', 'sync', 'off'], env).argv).toContain('{"on":false}')
    for (const v of ['reload', 'back', 'forward']) expect(run(['browser', v, '--tab', 't2'], env).argv).toEqual(expect.arrayContaining([url(v), '{"tab":"t2"}']))
    expect(run(['browser', 'navigate', 'https://example.com/', '--all'], env).argv).toContain('{"url":"https://example.com/","all":true}')
    expect(run(['browser', 'snapshot', '--all'], env).argv).toContain('{"all":true}')
    expect(run(['browser', 'screenshot', '--layout'], env).argv).toContain('{"layout":true}')
    expect(run(['browser', 'screenshot', '600', '--all'], env).argv).toContain('{"maxWidth":600,"all":true}')
    expect(run(['browser', 'click', '--all', '--text', 'Buy now', '--role', 'button', '--nth', '2'], env).argv).toContain('{"all":true,"name":"Buy now","role":"button","nth":2}')
    expect(run(['browser', 'type', 'shoes', '--all', '--text', 'Search', '--submit'], env).argv).toContain('{"text":"shoes","submit":true,"all":true,"name":"Search"}')
  })

  it('layout, sync and --all refuse bad input before any request leaves the machine', () => {
    installWebtermCli(home())
    const env = { WEBTERM_NODE_HEADERS: headers() }
    for (const args of [
      ['layout', 'zap'], ['layout', 'set'], ['layout', 'set', 'h', 'a', 'b', 'c', 'd', 'e'], ['sync'], ['sync', 'maybe'], ['open', '--all'], ['tab', 'new', '--all'],
      ['click', '--all'], ['type', 'x', '--all'], ['click', 'e1', 's1', '--text', 'Buy'], ['snapshot', '--layout'], ['click', '--all', '--text'], ['click', '--all', '--text', 'x', '--nth', 'two'],
    ]) {
      const r = run(['browser', ...args], env)
      expect([args, r.status]).toEqual([args, 2])
      expect(r.argv).toEqual([])
    }
  })

  it('context.sh <verb> reaches the context-link route through the CLI', () => {
    installWebtermCli(home())
    const shim = join(root, 'context.sh')
    writeFileSync(shim, buildContextShim(), { mode: 0o700 })
    const r = run(['summary', '--node', 'peer', '-n', '5'], { WEBTERM_NODE_HEADERS: headers(), WEBTERM_NODE_ID: 'n1' }, { script: shim })
    expect(r.argv).toContain('http://127.0.0.1:8700/api/context-link')
    expect(r.argv).toEqual(expect.arrayContaining(['verb=summary', 'want=peer', 'n=5', 'node=n1']))
  })
})
