// New project's initial commit against real git with a hermetic identity: empty HOME, no global or
// system config, and `user.useConfigOnly` so git never guesses a name from login + hostname (a dev
// laptop would otherwise "have" an identity). Never touches the real ~/.gitconfig.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CreateError, createProject } from './workspaceCreate'

const TEST_TIMEOUT_MS = 30_000
const IDENTITY_KEYS = ['GIT_AUTHOR_NAME', 'GIT_COMMITTER_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_EMAIL']
let tmp: string
let saved: NodeJS.ProcessEnv

beforeEach(() => {
  saved = { ...process.env }
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'wsc-id-')))
  for (const k of IDENTITY_KEYS) delete process.env[k]
  process.env.HOME = tmp
  process.env.GIT_CONFIG_GLOBAL = '/dev/null'
  process.env.GIT_CONFIG_NOSYSTEM = '1'
  process.env.GIT_CONFIG_COUNT = '1'
  process.env.GIT_CONFIG_KEY_0 = 'user.useConfigOnly'
  process.env.GIT_CONFIG_VALUE_0 = 'true'
})
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
  Object.assign(process.env, saved)
  rmSync(tmp, { recursive: true, force: true })
})

const author = (path: string) => execFileSync('git', ['-C', path, 'log', '--format=%an <%ae>'], { encoding: 'utf8' }).trim()

test('no git identity anywhere: the initial commit still succeeds as the bootstrap identity', async () => {
  const r = await createProject({ parent: tmp, name: 'bare' })
  expect(r.bootstrapIdentity).toBe(true)
  expect(author(r.path)).toBe('webterm <webterm@localhost>')
  expect(existsSync(join(tmp, '.gitconfig'))).toBe(false) // user config never written
}, TEST_TIMEOUT_MS)

test('the user identity (env) wins and bootstrapIdentity stays false', async () => {
  process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'Ada'
  process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'ada@example.test'
  const r = await createProject({ parent: tmp, name: 'mine' })
  expect(r.bootstrapIdentity).toBe(false)
  expect(author(r.path)).toBe('Ada <ada@example.test>')
}, TEST_TIMEOUT_MS)

test('the user identity (global config in HOME) wins too', async () => {
  const cfg = join(tmp, 'gitconfig')
  writeFileSync(cfg, '[user]\n\tname = Grace\n\temail = grace@example.test\n')
  process.env.GIT_CONFIG_GLOBAL = cfg
  const r = await createProject({ parent: tmp, name: 'cfg' })
  expect(r.bootstrapIdentity).toBe(false)
  expect(author(r.path)).toBe('Grace <grace@example.test>')
}, TEST_TIMEOUT_MS)

test('other git failures keep their context and clean up', async () => {
  const bad = join(tmp, 'broken-git')
  writeFileSync(bad, '#!/bin/sh\necho "fatal: boom" >&2\nexit 128\n') // test-only fake git
  chmodSync(bad, 0o755)
  const err = (await createProject({ parent: tmp, name: 'x' }, { git: bad }).catch((e: unknown) => e)) as CreateError
  expect(err.code).toBe('git_failed')
  expect(err.message).toContain('Could not initialize the git repository')
  expect(err.message).toContain('boom')
  expect(existsSync(join(tmp, 'x'))).toBe(false)
})
