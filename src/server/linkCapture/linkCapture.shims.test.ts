// The generated shims, run for real under /bin/sh against a fake webterm server and a fake "real opener".
// No browser is ever started: the real opener is a script that records its arguments.
import { execFile } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { LINK_BYPASS_ENV, LINK_HEADERS_ENV, LINK_OPEN_PATH, OPENER_SHIMS, OPEN_COMMAND } from './linkCapture.config'
import { installLinkCapture, shimDir } from './linkCapture.shims'

const dataRoot = mkdtempSync(join(tmpdir(), 'wt-shims-'))
process.env.WEBTERM_DATA_DIR = dataRoot
const realBin = join(dataRoot, 'realbin')
const openedLog = join(dataRoot, 'real-opener.log')
const headers = join(dataRoot, 'link.headers')

interface Seen { path: string; method: string; headers: http.IncomingHttpHeaders; body: string }
let seen: Seen[] = []
let reply: { status: number; body: string } = { status: 200, body: '{"ok":true,"mode":"canvas"}' }
let server: http.Server
let port = 0

beforeAll(async () => {
  installLinkCapture()
  mkdirSync(realBin, { recursive: true })
  // A "real opener" under every name: records its args, proves what reached it, never opens anything.
  for (const name of OPENER_SHIMS) {
    const f = join(realBin, name)
    writeFileSync(f, `#!/bin/sh\nprintf '%s|%s\\n' "$(basename "$0")" "$*" >> '${openedLog}'\nprintf 'bypass=%s\\n' "\${${LINK_BYPASS_ENV}:-}" >> '${openedLog}'\n`)
    chmodSync(f, 0o755)
  }
  writeFileSync(headers, 'x-webterm-link-token: abc.node1\n')
  server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c: Buffer) => { body += c.toString() })
    req.on('end', () => {
      seen.push({ path: req.url ?? '', method: req.method ?? '', headers: req.headers, body })
      res.statusCode = reply.status
      res.setHeader('content-type', 'application/json')
      res.end(reply.body)
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  port = (server.address() as AddressInfo).port
})
afterAll(() => { server.close() })
afterEach(() => { seen = []; reply = { status: 200, body: '{"ok":true,"mode":"canvas"}' } })

const real = (): string => (existsSync(openedLog) ? readFileSync(openedLog, 'utf8') : '')
const reset = (): void => { writeFileSync(openedLog, '') }

/** Run `<shimDir>/<cmd> args` with webterm session env; PATH = shims, then the fake real openers, then the system. */
function run(cmd: string, args: string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  reset()
  const base = { PATH: `${shimDir()}:${realBin}:/usr/bin:/bin`, HOME: dataRoot, WEBTERM_PORT: String(port), [LINK_HEADERS_ENV]: headers }
  return new Promise((resolve) => {
    execFile(join(shimDir(), cmd), args, { env: { ...base, ...env } }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr })
    })
  })
}

describe('link catcher shims', () => {
  it('installs webterm-open and one shim per opener name, executable', () => {
    for (const name of [OPEN_COMMAND, ...OPENER_SHIMS]) expect(existsSync(join(shimDir(), name)), name).toBe(true)
  })

  it('open <http url> posts the URL to the server with the link credential and never reaches the real opener', async () => {
    const r = await run('open', ['https://example.com/login?code=abc'])
    expect(r.code).toBe(0)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ path: LINK_OPEN_PATH, method: 'POST' })
    expect(seen[0].headers['x-webterm-link-token']).toBe('abc.node1')
    expect(JSON.parse(seen[0].body)).toEqual({ url: 'https://example.com/login?code=abc' })
    expect(real()).toBe('')
  })

  it.each(OPENER_SHIMS)('%s is caught the same way', async (name) => {
    const r = await run(name, ['http://localhost:8123/callback'])
    expect(r.code).toBe(0)
    expect(seen.map((s) => JSON.parse(s.body).url)).toEqual(['http://localhost:8123/callback'])
  })

  it('webterm-open (the BROWSER handler) takes the URL even next to flags', async () => {
    const r = await run(OPEN_COMMAND, ['--new-window', 'https://example.com/a'])
    expect(r.code).toBe(0)
    expect(seen.map((s) => JSON.parse(s.body).url)).toEqual(['https://example.com/a'])
  })

  it('escapes quotes and backslashes in the URL into valid JSON', async () => {
    await run('open', ['https://example.com/a"b\\c'])
    expect(JSON.parse(seen[0].body).url).toBe('https://example.com/a"b\\c')
  })

  it.each([
    ['a file', ['/tmp/report.pdf']],
    ['a folder', ['.']],
    ['an app flag with a URL', ['-a', 'Safari', 'https://example.com']],
    ['a mailto link', ['mailto:someone@example.com']],
    ['a file: URL', ['file:///tmp/x.html']],
    ['a URL mixed with a path', ['https://example.com', '/tmp/x']],
  ])('open with %s goes to the real opener and the server is not asked', async (_label, args) => {
    const r = await run('open', args)
    expect(r.code).toBe(0)
    expect(seen).toHaveLength(0)
    expect(real()).toContain(`open|${args.join(' ')}`)
  })

  it('the real opener runs with the bypass flag, so it cannot loop back into a shim', async () => {
    await run('xdg-open', ['/tmp/x'])
    expect(real()).toContain('bypass=1')
    reset()
    const r = await run('open', ['https://example.com'], { [LINK_BYPASS_ENV]: '1' })
    expect(r.code).toBe(0)
    expect(seen).toHaveLength(0)
    expect(real()).toContain('open|https://example.com')
  })

  it('skips its own shim dir when looking for the real opener (no recursion even with the shim dir first)', async () => {
    const r = await run('open', ['/tmp/y'], { PATH: `${shimDir()}:${shimDir()}:${realBin}:/usr/bin:/bin` })
    expect(r.code).toBe(0)
    expect(real()).toContain('open|/tmp/y')
  })

  it('outside a webterm session (no credentials) every call is the real opener', async () => {
    const r = await run('open', ['https://example.com'], { [LINK_HEADERS_ENV]: join(dataRoot, 'missing.headers') })
    expect(r.code).toBe(0)
    expect(seen).toHaveLength(0)
    expect(real()).toContain('open|https://example.com')
  })

  it('an agent session uses its node header file when present', async () => {
    const node = join(dataRoot, 'node.headers')
    writeFileSync(node, 'x-webterm-node-token: nodetok\nx-webterm-token: nodetok\n')
    await run('open', ['https://example.com'], { WEBTERM_NODE_HEADERS: node, [LINK_HEADERS_ENV]: '' })
    expect(seen[0].headers['x-webterm-node-token']).toBe('nodetok')
  })

  it('when the server says "machine" (switch off) the real opener gets the link', async () => {
    reply = { status: 200, body: '{"ok":true,"mode":"machine"}' }
    const r = await run('open', ['https://example.com'])
    expect(r.code).toBe(0)
    expect(real()).toContain('open|https://example.com')
  })

  it('a refusal is printed with its reason and the URL, exits non-zero and does NOT fall back to the machine browser', async () => {
    reply = { status: 409, body: '{"error":"max_live","message":"The live browser limit is reached."}' }
    const r = await run('open', ['https://example.com/x'])
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('could not open in canvas browser: The live browser limit is reached.')
    expect(r.stderr).toContain('URL: https://example.com/x')
    expect(real()).toBe('')
  })

  it('an unreachable server is reported the same way', async () => {
    const r = await run('open', ['https://example.com/x'], { WEBTERM_PORT: '1' })
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('could not open in canvas browser: the webterm server did not answer')
    expect(real()).toBe('')
  })
})
