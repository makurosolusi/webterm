// Bun-only (real PTY via spawnPty). Plan F0-a exit criteria, against a temp data dir:
// a shell spawned the way an agent is spawned must not find the root token in its env or in any
// file webterm hands to nodes, and the Claude settings webterm writes must wall off the data dir.
import { test, expect, afterAll } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

const DATA_DIR = realpathSync(mkdtempSync(join(tmpdir(), 'webterm-sbx-')))
process.env.WEBTERM_DATA_DIR = DATA_DIR
const ORIGINAL_HOME = process.env.HOME
const ORIGINAL_TOKEN = process.env.WEBTERM_TOKEN
process.env.HOME = DATA_DIR // keep login-shell rc files of the user out of the PTY
const ROOT = 'ROOTSENTINEL0123456789abcdefghijklmnopqrstuv' // test-only fixture, not a real token
process.env.WEBTERM_TOKEN = ROOT // what the server process holds when a root token is enforced
afterAll(() => {
  process.env.HOME = ORIGINAL_HOME
  if (ORIGINAL_TOKEN === undefined) delete process.env.WEBTERM_TOKEN
  else process.env.WEBTERM_TOKEN = ORIGINAL_TOKEN
  rmSync(DATA_DIR, { recursive: true, force: true })
})

import type { ServerMsg } from '../shared/protocol'
import { Sessions } from './sessions'
import { nodeIdForToken, nodeToken, writeClaudeSettings } from './hooks'
import { claudeHeadersPath } from './hooksPaths'
import { buildContextShim } from './contextLinkSkill'
import { buildBrowserShim } from './browserAgentShim'
import { installWebtermCli } from './cli/cli.launcher'
import { TOKEN_HEADER } from './auth'
import { shq } from './hooksQuote'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function runAgentShell(id: string, agentId: string, cmd: string, marker: string): Promise<string> {
  const s = new Sessions()
  const chunks: string[] = []
  const send = (m: ServerMsg) => { if (m.t === 'output') chunks.push(m.data) }
  try {
    s.open({ t: 'open', id, cols: 200, rows: 50, cmd, agentId }, send)
    const deadline = Date.now() + 30_000
    while (!chunks.join('').includes(marker)) {
      if (Date.now() > deadline) throw new Error(`agent shell ${id} never printed ${marker}; tail=${JSON.stringify(chunks.join('').slice(-300))}`)
      await sleep(50)
    }
    return chunks.join('')
  } finally {
    s.close(id)
  }
}

test('an agent PTY finds no root token: not in its env, not in auth.json, not in any node file', async () => {
  // The root token file exists on disk exactly where webterm keeps it.
  mkdirSync(join(DATA_DIR, 'secrets'), { recursive: true })
  writeFileSync(join(DATA_DIR, 'secrets', 'WEBTERM_TOKEN'), ROOT, { mode: 0o600 })
  writeClaudeSettings('node-b', 8700) // another node's settings + header file sit next door
  const d = shq(DATA_DIR)
  // Counts only: a value must never reach the PTY output.
  const cmd = [
    `printf 'ENV_ROOT=%s\\n' "$(env | grep -c ${ROOT})"`,
    `printf 'ENV_NODE_TOKEN=%s\\n' "$(env | grep -c ${nodeToken('node-a')})"`,
    `printf 'ENV_TOKEN_VARS=%s\\n' "$(env | grep -cE '^(WEBTERM_TOKEN|NODETERM_NODE_TOKEN)=')"`,
    `printf 'HEADERS_ENV_IS_OWN=%s\\n' "$([ "$WEBTERM_NODE_HEADERS" = ${shq(claudeHeadersPath('node-a'))} ] && [ -r "$WEBTERM_NODE_HEADERS" ] && echo yes || echo no)"`,
    `cat ${d}/auth.json >/dev/null 2>&1; printf 'AUTH_JSON_EXIT=%s\\n' "$?"`,
    `printf 'NODE_FILES_WITH_ROOT=%s\\n' "$(grep -rl ${ROOT} ${d}/node-settings ${d}/context-links ${d}/browser-agent 2>/dev/null | wc -l | tr -d ' ')"`,
    `echo DONE_A`,
  ].join('; ')
  const out = await runAgentShell('node-a', 'claude', cmd, 'DONE_A')
  expect(out).toContain('ENV_ROOT=0')
  // V5: env is readable by sibling processes, so no token VALUE may sit there — only the file path.
  expect(out).toContain('ENV_NODE_TOKEN=0')
  expect(out).toContain('ENV_TOKEN_VARS=0')
  expect(out).toContain('HEADERS_ENV_IS_OWN=yes')
  expect(out).not.toContain('AUTH_JSON_EXIT=0')
  expect(out).toContain('NODE_FILES_WITH_ROOT=0')
  expect(out.includes(ROOT)).toBe(false)
}, 90_000)

test('a non-Claude agent PTY gets the same env guarantees (its label stays "mitigation")', async () => {
  const out = await runAgentShell('node-c', 'codex', `printf 'ENV_ROOT=%s\\n' "$(env | grep -c ${ROOT})"; echo DONE_C`, 'DONE_C')
  expect(out).toContain('ENV_ROOT=0')
}, 90_000)

test('the settings file a Claude node is launched with walls off the data dir', () => {
  const path = writeClaudeSettings('node-d', 8700)
  const s = JSON.parse(readFileSync(path, 'utf8'))
  expect(s.hooks).toBeDefined()
  expect(s.permissions.deny).toContain(`Read(/${DATA_DIR}/secrets/**)`)
  expect(s.permissions.deny).toContain(`Read(/${DATA_DIR}/node-settings/**)`)
  expect(s.permissions.deny).toContain('Read(**/.env)')
  if (process.platform === 'darwin') {
    expect(s.sandbox.enabled).toBe(true)
    expect(s.sandbox.filesystem.denyRead).toEqual([DATA_DIR])
    expect(s.sandbox.filesystem.denyWrite).toContain(join(DATA_DIR, 'secrets'))
  }
  // The file never carries a token value, root or node.
  const raw = readFileSync(path, 'utf8')
  expect(raw.includes(ROOT)).toBe(false)
  expect(raw.includes(nodeToken('node-d'))).toBe(false)
})

test('the real shims, run inside an agent PTY, still authenticate as that node via its header file', async () => {
  // Stand-in server: answers with the node a transport token proves (what /api/context-link and the
  // browser control route check), or 401. Real curl, real shim text, real PTY env.
  const server = createServer((req, res) => {
    const raw = req.headers[TOKEN_HEADER]
    const owner = nodeIdForToken(typeof raw === 'string' ? raw : '')
    res.statusCode = owner ? 200 : 401
    res.end(owner ? `AUTH_OK:${owner}` : 'AUTH_NO')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  try {
    const ctx = join(DATA_DIR, 'ctx.sh')
    const browser = join(DATA_DIR, 'browser.sh')
    installWebtermCli(DATA_DIR) // both shims are aliases that exec the `webterm` CLI
    writeFileSync(ctx, buildContextShim(), { mode: 0o700 })
    writeFileSync(browser, buildBrowserShim(), { mode: 0o700 })
    const cmd = `NODETERM_PORT=${port} sh ${shq(ctx)}; echo; NODETERM_PORT=${port} sh ${shq(browser)} status; echo DONE_S`
    const out = await runAgentShell('node-s', 'claude', cmd, 'DONE_S')
    expect(out.match(/AUTH_OK:node-s/g)?.length).toBe(2)
    expect(out).not.toContain('AUTH_NO')
    expect(out.includes(nodeToken('node-s'))).toBe(false) // token never echoed by the shims
  } finally {
    server.close()
  }
}, 90_000)

test("node A's sandbox opens only A's header file; node B's stays under the denied data dir", () => {
  if (process.platform !== 'darwin') return // sandbox block is macOS-only (agentSandbox.ts)
  const a = JSON.parse(readFileSync(writeClaudeSettings('node-x', 8700), 'utf8'))
  writeClaudeSettings('node-y', 8700)
  const allow: string[] = a.sandbox.filesystem.allowRead
  expect(allow).toContain(claudeHeadersPath('node-x'))
  expect(allow).not.toContain(claudeHeadersPath('node-y'))
  expect(allow.some((p) => p === join(DATA_DIR, 'node-settings'))).toBe(false)
  expect(a.sandbox.filesystem.denyRead).toEqual([DATA_DIR])
  expect(claudeHeadersPath('node-y').startsWith(`${DATA_DIR}/`)).toBe(true)
})
