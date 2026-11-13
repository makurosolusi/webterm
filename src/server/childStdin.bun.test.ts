// A child that exits before reading its stdin must never become an uncaught EPIPE (in the native app
// that is forceExit(1) of the whole app: "About this machine" killed it via the MCP probe). Each case
// runs the REAL module against a child that dies at once and asserts no uncaught exception escaped.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { execFile, spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import npath from 'node:path'
import { promisify } from 'node:util'
import { endChildStdin } from './childStdin'
import { probeMcpServer } from './mcp/mcp.health'
import { fileDiff, undoHunk } from './gitDiff'
import { repoOf, snapshotTree } from './checkpoint/checkpoint.git'

const run = promisify(execFile)
const T = 60_000
/** Far past any pipe buffer, so the write is still pending when the child exits: EPIPE every run. */
const BIG = 'x'.repeat(4 * 1024 * 1024)

let uncaught: unknown[] = []
const onUncaught = (e: unknown) => { uncaught.push(e) }
beforeEach(() => {
  uncaught = []
  process.on('uncaughtException', onUncaught)
  process.on('unhandledRejection', onUncaught)
})
afterEach(() => {
  process.off('uncaughtException', onUncaught)
  process.off('unhandledRejection', onUncaught)
})
/** Lets a late stdin 'error' (emitted after close) surface before asserting. */
const settle = () => new Promise((r) => setTimeout(r, 50))

test('endChildStdin: a big write to a child that exits at once is not an uncaught error', async () => {
  for (let i = 0; i < 5; i++) {
    const child = spawn('/bin/sh', ['-c', 'exit 3'], { stdio: ['pipe', 'ignore', 'ignore'] })
    const code = await new Promise<number | null>((done) => {
      child.on('close', done)
      endChildStdin(child.stdin, BIG, { op: 'test', command: 'sh' })
    })
    expect(code).toBe(3)
  }
  await settle()
  expect(uncaught).toEqual([])
}, T)

test('probeMcpServer with a missing script resolves ok:false, never an uncaught EPIPE (cold spawn race)', async () => {
  const launch = { command: process.execPath, args: [npath.join(tmpdir(), 'webterm-no-such-mcp-main.ts')] }
  for (let i = 0; i < 10; i++) {
    const r = await probeMcpServer(launch, 15_000)
    expect(r.ok).toBe(false)
  }
  await settle()
  expect(uncaught).toEqual([])
}, T)

// Real git, except the stdin-reading subcommands, which a fake `git` first on PATH makes exit at once.
describe('stdin-reading git children that exit at once', () => {
  let bin = ''
  let root = ''
  const oldPath = process.env.PATH
  const GIT_ENV = { // test-only identity, isolated from the user's git config
    ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t.test', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t.test',
  }
  const g = (...args: string[]) => run('git', args, { cwd: root, env: GIT_ENV })

  beforeAll(async () => {
    const realGit = (await run('/bin/sh', ['-c', 'command -v git'])).stdout.trim()
    bin = await fs.mkdtemp(npath.join(tmpdir(), 'webterm-fakegit-'))
    await fs.writeFile(npath.join(bin, 'git'), `#!/bin/sh\nfor a in "$@"; do case "$a" in apply|update-index) exit 1;; esac; done\nexec "${realGit}" "$@"\n`, { mode: 0o755 })
    process.env.PATH = `${bin}:${oldPath ?? ''}`
  })
  afterAll(async () => {
    process.env.PATH = oldPath
    await fs.rm(bin, { recursive: true, force: true })
  })
  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(npath.join(tmpdir(), 'webterm-epipe-')))
    await g('init', '-q', '-b', 'main')
    await fs.writeFile(npath.join(root, 'big.txt'), 'a\n')
    await g('add', '.')
    await g('commit', '-q', '-m', 'init')
  })
  afterEach(() => fs.rm(root, { recursive: true, force: true }))

  test('gitDiff undoHunk: git apply dying before reading the patch is a conflict, not an uncaught EPIPE', async () => {
    // Under the Diff node's 1 MiB cap (so it has hunks), still far past any pipe buffer.
    await fs.writeFile(npath.join(root, 'big.txt'), `${'x'.repeat(900 * 1024)}\n`)
    const hunk = (await fileDiff(root, 'big.txt')).hunks[0]
    expect(hunk).toBeDefined()
    for (let i = 0; i < 3; i++) expect(await undoHunk(root, 'big.txt', hunk!.id).catch((e: unknown) => e)).toMatchObject({ code: 'conflict' })
    await settle()
    expect(uncaught).toEqual([])
  }, T)

  test('checkpoint snapshotTree: update-index dying before reading the list rejects, not an uncaught EPIPE', async () => {
    const name = (i: number) => `${String(i).padStart(5, '0')}-${'n'.repeat(200)}`
    for (let i = 0; i < 1500; i++) await fs.writeFile(npath.join(root, name(i)), '')
    const repo = await repoOf(root)
    expect(repo).not.toBeNull()
    for (let i = 0; i < 3; i++) expect(String(await snapshotTree(repo!).catch((e: unknown) => e))).toMatch(/git update-index failed/)
    await settle()
    expect(uncaught).toEqual([])
  }, T)
})
