// Bun-only: the secret broker over the real ledger schema — injection + masked output, no value in
// receipts/events, deny without a grant, grant pattern scoping, names-only listing, and the
// `/api/tools` execute() wiring.
import { afterAll, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Workspace } from '../../shared/workspace'
import { freshDb, rows } from '../central/guard/controlGuard.testutil'
import { execute } from '../cli/cli.exec'
import { TOOL_INDEX } from '../cli/cli.registry'
import { createEventLog } from '../events/eventLog'
import { createPolicy } from '../policy/policy.decide'
import { runSecretCapability, type BrokerDeps } from './secret.broker'
import { maskVariants } from './secret.redact'
import { createBrokerStore, lastUsedByName } from './secret.store'

// Real child processes: under a loaded machine (full suite in parallel) the 5 s bun default is too tight.
const SPAWN_TEST_MS = 30_000
const root = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'secret-broker-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const VALUE = 'test-only/S3cr3t+val=ue?&x' // test-only fixture, never a real credential
const OTHER = 'test-only-other-value-42' // test-only
const work = join(root, 'work')
mkdirSync(work)
// A fake `npm` on PATH so a real `npm publish ...` argv matches the grant pattern without touching npm.
const bin = join(root, 'bin')
mkdirSync(bin)
writeFileSync(join(bin, 'npm'), '#!/bin/sh\necho "npm $* len=${#NPM_TOKEN}"\necho "$NPM_TOKEN"\n')
chmodSync(join(bin, 'npm'), 0o755)
process.env.PATH = `${bin}:${process.env.PATH ?? ''}`

const BOARD: Workspace[] = [{
  id: 'w1', name: 'w', viewport: { x: 0, y: 0, zoom: 1 }, cwd: work, updatedAt: 0, bridges: [],
  nodes: [{ id: 'a1', kind: 'agent', x: 0, y: 0 }, { id: 'a2', kind: 'agent', x: 0, y: 0 }],
} as unknown as Workspace]

function setup() {
  const db = freshDb()
  const events = createEventLog(db)
  const policy = createPolicy({ db, events })
  const store = createBrokerStore(join(root, `store-${Math.random().toString(36).slice(2)}`))
  store.write('NPM_TOKEN', VALUE)
  store.write('OTHER_KEY', OTHER)
  const deps: BrokerDeps = { policy: () => policy, workspaces: () => BOARD, store, events: () => events, lastUsed: () => lastUsedByName(db) }
  return { db, policy, deps, store }
}

const everything = (db: Database): string => JSON.stringify(rows(db, 'SELECT * FROM event'))
/** Prints the injected value raw, base64 at three offsets (std + url), URI-encoded and JSON-escaped. */
const printer = [process.execPath, '-e', [
  'const v = process.env.NPM_TOKEN',
  'console.log("len=" + v.length)',
  'console.log(v)',
  'for (const p of ["", "a", "ab"]) { const b = Buffer.from(p + v + "zz"); console.log(b.toString("base64")); console.log(b.toString("base64url")) }',
  'console.log(encodeURIComponent(v))',
  'console.log(JSON.stringify({ v }))',
  'console.error("err:" + v)',
].join(';')]

test('agent gets the command output with the value masked in every form, and the env var really was injected', async () => {
  const { policy, deps } = setup()
  policy.createGrant('human-ui', { subject: 'node:a1', capability: 'secret.run', scope: 'secret:NPM_TOKEN:*', effect: 'allow' })
  const out = await runSecretCapability(deps, 'secret.run', { names: ['NPM_TOKEN'], command: printer }, 'node:a1')
  expect(out.receipt).toMatchObject({ outcome: 'ok', detail: 'ok' })
  const data = out.data as { stdout: string; stderr: string; exitCode: number }
  expect(data.exitCode).toBe(0)
  expect(data.stdout).toContain(`len=${VALUE.length}`)
  const forms = [VALUE, encodeURIComponent(VALUE), ...['', 'a', 'ab'].flatMap((p) => {
    const b = Buffer.from(p + VALUE + 'zz')
    return [b.toString('base64'), b.toString('base64url')]
  })]
  for (const f of forms) expect(data.stdout).not.toContain(f)
  for (const v of maskVariants(VALUE)) expect(`${data.stdout}${data.stderr}`).not.toContain(v)
  expect(data.stderr).toBe('err:[redacted]\n')
  expect(data.stdout.split('[redacted]').length - 1).toBeGreaterThan(8)
}, SPAWN_TEST_MS)

test('the value never reaches the receipt, the decision or use events, or another node\'s env', async () => {
  const { db, policy, deps } = setup()
  policy.createGrant('human-ui', { subject: 'node:a1', capability: 'secret.run', scope: 'secret:NPM_TOKEN:*', effect: 'allow' })
  const out = await runSecretCapability(deps, 'secret.run', { names: ['NPM_TOKEN'], command: printer }, 'node:a1')
  const dump = `${JSON.stringify(out)}${everything(db)}`
  for (const v of [VALUE, OTHER, ...maskVariants(VALUE)]) expect(dump).not.toContain(v)
  const use = rows(db, "SELECT actor, subject, payload_json FROM event WHERE kind = 'secret.use'")
  expect(use).toHaveLength(1)
  expect(use[0]).toMatchObject({ actor: 'node:a1', subject: 'secret:NPM_TOKEN' })
  const payload = JSON.parse(String(use[0].payload_json)) as { commandHash: string }
  expect(payload).toMatchObject({ name: 'NPM_TOKEN', exitCode: 0 })
  expect(payload.commandHash).toMatch(/^[0-9a-f]{64}$/)
  expect(out.receipt.evidence).toMatchObject({ names: ['NPM_TOKEN'], exitCode: 0 })
}, SPAWN_TEST_MS)

test('without a grant a node is denied (asked by default) and the command never runs', async () => {
  const { db, deps } = setup()
  const marker = join(root, 'ran-without-grant')
  const out = await runSecretCapability(deps, 'secret.run', { names: ['NPM_TOKEN'], command: ['touch', marker] }, 'node:a1')
  expect(out.receipt).toMatchObject({ outcome: 'denied', detail: 'approval_required' })
  expect(out.data === undefined).toBe(true)
  expect(existsSync(marker)).toBe(false)
  expect(rows(db, "SELECT 1 FROM event WHERE kind = 'secret.use'")).toHaveLength(0)
  expect(everything(db)).not.toContain(VALUE)
}, SPAWN_TEST_MS)

test('a human deny rule beats the default and a grant is scoped to node, secret and command pattern', async () => {
  const { policy, deps } = setup()
  policy.createGrant('human-ui', { subject: 'node:a1', capability: 'secret.run', scope: 'secret:NPM_TOKEN:npm publish*', effect: 'allow' })
  const run = (principal: string, names: string[], command: string[]) => runSecretCapability(deps, 'secret.run', { names, command }, principal)

  const ok = await run('node:a1', ['NPM_TOKEN'], ['npm', 'publish', '--tag', 'next'])
  expect(ok.receipt.outcome).toBe('ok')
  expect((ok.data as { stdout: string }).stdout).toBe(`npm publish --tag next len=${VALUE.length}\n[redacted]\n`)

  expect((await run('node:a1', ['NPM_TOKEN'], ['npm', 'whoami'])).receipt.detail).toBe('approval_required')
  expect((await run('node:a1', ['NPM_TOKEN', 'OTHER_KEY'], ['npm', 'publish'])).receipt).toMatchObject({ outcome: 'denied', evidence: { name: 'OTHER_KEY' } })
  expect((await run('node:a2', ['NPM_TOKEN'], ['npm', 'publish'])).receipt.outcome).toBe('denied')

  policy.createGrant('human-ui', { subject: 'node:a1', capability: 'secret.run', scope: 'secret:NPM_TOKEN:*', effect: 'deny' })
  expect((await run('node:a1', ['NPM_TOKEN'], ['npm', 'publish'])).receipt.detail).toBe('policy_denied')
}, SPAWN_TEST_MS)

test('a rule limited to one workspace lets only that board\'s agents use the secret', async () => {
  const { policy, deps } = setup()
  const other = { ...BOARD[0], id: 'w2', nodes: [{ id: 'b1', kind: 'agent', x: 0, y: 0 }] } as unknown as Workspace
  const board: BrokerDeps = { ...deps, workspaces: () => [...BOARD, other] }
  policy.createGrant('human-ui', { subject: 'node:*', capability: 'secret.run', scope: 'secret:NPM_TOKEN:*', workspaceId: 'w1', effect: 'allow' })
  const run = (principal: string) => runSecretCapability(board, 'secret.run', { names: ['NPM_TOKEN'], command: ['true'] }, principal)
  expect((await run('node:a1')).receipt.outcome).toBe('ok')
  expect((await run('node:a2')).receipt.outcome).toBe('ok')
  expect((await run('node:b1')).receipt.detail).toBe('approval_required')
  expect((await run('node:ghost')).receipt.detail).toBe('approval_required')
}, SPAWN_TEST_MS)

test('a node cannot run outside its folder; unknown secrets and empty argv are refused', async () => {
  const { policy, deps } = setup()
  policy.createGrant('human-ui', { subject: 'node:a1', capability: 'secret.run', scope: '*', effect: 'allow' })
  expect((await runSecretCapability(deps, 'secret.run', { names: ['NPM_TOKEN'], command: ['pwd'], cwd: '..' }, 'node:a1')).receipt.detail).toBe('outside_cwd')
  expect((await runSecretCapability(deps, 'secret.run', { names: ['NOPE'], command: ['pwd'] }, 'node:a1')).receipt.detail).toBe('unknown_secret')
  expect((await runSecretCapability(deps, 'secret.run', { names: ['NPM_TOKEN'], command: [] }, 'node:a1')).receipt.detail).toBe('invalid_shape')
  const pwd = await runSecretCapability(deps, 'secret.run', { names: ['NPM_TOKEN'], command: ['pwd'] }, 'node:a1')
  expect((pwd.data as { stdout: string }).stdout.trim()).toMatch(/work$/)
}, SPAWN_TEST_MS)

test('secret.list returns names and last-used only, through the /api/tools execute() path', async () => {
  const { policy, deps } = setup()
  policy.createGrant('human-ui', { subject: 'node:a1', capability: 'secret.run', scope: '*', effect: 'allow' })
  const before = await runSecretCapability(deps, 'secret.list', {}, 'node:a2')
  expect(before.data).toEqual({ secrets: [{ name: 'NPM_TOKEN', lastUsedAt: null }, { name: 'OTHER_KEY', lastUsedAt: null }] })
  await runSecretCapability(deps, 'secret.run', { names: ['NPM_TOKEN'], command: ['true'] }, 'node:a1')

  const cap = TOOL_INDEX.get('secret.list')
  expect(cap).toBeDefined()
  // execute() dispatches secret.* to the broker; the broker deps it forwards are the tools deps.
  const toolDeps = { ...deps, dispatch: async () => { throw new Error('secret.* must not go through the HTTP router') } }
  const out = await execute(toolDeps as never, cap!, {}, 'node:a2', {})
  expect(out.receipt.outcome).toBe('ok')
  const listed = (out.data as { secrets: { name: string; lastUsedAt: number | null }[] }).secrets
  expect(listed.map((s) => s.name)).toEqual(['NPM_TOKEN', 'OTHER_KEY'])
  expect(listed[0].lastUsedAt).toEqual(expect.any(Number))
  expect(listed[1].lastUsedAt).toBeNull()
  expect(JSON.stringify(out)).not.toContain(VALUE)
  expect(JSON.stringify(out)).not.toContain(OTHER)
}, SPAWN_TEST_MS)
