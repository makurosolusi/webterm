// Bun-only: `/api/secrets` is UI-only (agent credentials and non-browser callers get 403), never answers
// with a value, writes 0600 files, and the GET usage log carries names + command hash only.
import { TEST_UI_COOKIE } from '../uiSession.testutil'
import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import { join } from 'node:path'
import { CAPABILITY_HEADER, TOKEN_HEADER } from '../auth'
import { freshDb, rows } from '../central/guard/controlGuard.testutil'
import { createEventLog } from '../events/eventLog'
import { createPolicy } from '../policy/policy.decide'
import { handleSecretsApi, SECRETS_PATH, type SecretsApiDeps } from './secret.api'
import { runSecretCapability } from './secret.broker'
import { createBrokerStore } from './secret.store'

// Real child processes: under a loaded machine (full suite in parallel) the 5 s bun default is too tight.
const SPAWN_TEST_MS = 30_000
const root = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'secret-api-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const VALUE = 'test-only-npm-value-0123456789' // test-only fixture
const NODE_TOKEN = 'test-only-node-token' // test-only
const UI = { host: '127.0.0.1:8700', origin: 'http://127.0.0.1:8700', 'sec-fetch-site': 'same-origin', cookie: TEST_UI_COOKIE }

function setup() {
  const db = freshDb()
  const events = createEventLog(db)
  const dir = join(root, `s-${Math.random().toString(36).slice(2)}`)
  const deps: SecretsApiDeps = { store: createBrokerStore(dir), db, events, isNodeToken: (t) => t === NODE_TOKEN }
  const call = (method: string, path: string, headers: Record<string, string> = UI, body?: unknown) =>
    handleSecretsApi({ method, headers } as unknown as IncomingMessage, new URL(path, 'http://x'), body, deps)
  return { db, events, dir, deps, call }
}

test('agent credentials and non-browser callers are refused on every verb', () => {
  const { call, deps } = setup()
  const path = `${SECRETS_PATH}/NPM_TOKEN`
  expect(call('PUT', path, { ...UI, [TOKEN_HEADER]: NODE_TOKEN }, { value: VALUE })).toEqual({ status: 403, body: { error: 'agent_cannot_manage_secrets' } })
  // A query token is no credential either way: without the cookie it opens nothing.
  const { cookie: _signedIn, ...forged } = UI
  expect(call('PUT', `${path}?token=${NODE_TOKEN}`, forged, { value: VALUE }).status).toBe(403)
  expect(call('GET', SECRETS_PATH, { ...UI, [CAPABILITY_HEADER]: 'wcap_test-only' }).status).toBe(403)
  expect(call('DELETE', path, { host: '127.0.0.1:8700' })).toEqual({ status: 403, body: { error: 'approval_browser_only' } })
  expect(call('PUT', path, { ...UI, origin: 'http://evil.example' }, { value: VALUE }).status).toBe(403)
  expect(deps.store.names()).toEqual([])
}, SPAWN_TEST_MS)

test('the UI adds, replaces and deletes; answers and events never carry the value; files are 0600', () => {
  const { call, db, dir } = setup()
  expect(call('PUT', `${SECRETS_PATH}/NPM_TOKEN`, UI, { value: VALUE })).toEqual({ status: 200, body: { ok: true, name: 'NPM_TOKEN' } })
  expect(statSync(join(dir, 'NPM_TOKEN')).mode & 0o777).toBe(0o600)
  expect(statSync(dir).mode & 0o777).toBe(0o700)
  expect(call('PUT', `${SECRETS_PATH}/NPM_TOKEN`, UI, { value: `${VALUE}-2` }).status).toBe(200)
  expect(call('PUT', `${SECRETS_PATH}/NPM_TOKEN`, UI, { value: 'short' }).body).toMatchObject({ error: 'invalid_value' })
  expect(call('PUT', `${SECRETS_PATH}/lower`, UI, { value: VALUE }).body).toEqual({ error: 'invalid_name' })
  const list = call('GET', SECRETS_PATH)
  expect(list.body).toEqual({ secrets: [{ name: 'NPM_TOKEN', lastUsedAt: null }], usage: [] })
  expect(call('DELETE', `${SECRETS_PATH}/NPM_TOKEN`).status).toBe(200)
  expect(call('DELETE', `${SECRETS_PATH}/NPM_TOKEN`).status).toBe(404)
  const changes = rows(db, "SELECT payload_json FROM event WHERE kind = 'secret.change' ORDER BY seq").map((r) => JSON.parse(String(r.payload_json)).op)
  expect(changes).toEqual(['create', 'replace', 'delete'])
  expect(JSON.stringify(rows(db, 'SELECT * FROM event'))).not.toContain(VALUE)
}, SPAWN_TEST_MS)

test('GET shows last use and a usage log of name, principal and command hash', async () => {
  const { call, db, events, deps } = setup()
  call('PUT', `${SECRETS_PATH}/NPM_TOKEN`, UI, { value: VALUE })
  const policy = createPolicy({ db, events })
  policy.createGrant('human-ui', { subject: 'node:a1', capability: 'secret.run', scope: '*', effect: 'allow' })
  const board = [{ id: 'w1', cwd: root, nodes: [{ id: 'a1', kind: 'agent' }], bridges: [] }] as never
  await runSecretCapability({ policy: () => policy, workspaces: () => board, store: deps.store, events: () => events }, 'secret.run', { names: ['NPM_TOKEN'], command: ['true'] }, 'node:a1')
  const body = call('GET', SECRETS_PATH).body as { secrets: { lastUsedAt: number | null }[]; usage: Record<string, unknown>[] }
  expect(body.secrets[0].lastUsedAt).toEqual(expect.any(Number))
  expect(body.usage).toHaveLength(1)
  expect(body.usage[0]).toMatchObject({ name: 'NPM_TOKEN', principal: 'node:a1', exitCode: 0 })
  expect(String(body.usage[0].commandHash)).toMatch(/^[0-9a-f]{64}$/)
  expect(JSON.stringify(body)).not.toContain(VALUE)
}, SPAWN_TEST_MS)
