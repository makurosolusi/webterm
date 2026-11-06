// sec-208-2 lock. (1) Policy: every server-side git spawn goes through gitExec.ts; a new call site
// that spawns `git` directly fails here. (2) Regression: a repo carrying its own fsmonitor, external
// diff and textconv driver (the untrusted-clone case) runs none of them through the background git
// callers, and the env webterm builds for git carries no root/bot token.
import { afterAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { gitCommand, gitEnv } from './gitExec'

const SERVER = import.meta.dirname
const HELPER = join(SERVER, 'gitExec.ts')
const TEST_FILE = /\.(test|testutil)\.ts$/
/** Direct `git` spawns: execFile('git', …), spawn(['git', …]), deps.git ?? 'git', {file: 'git'}. */
const DIRECT_GIT = [
  /[([]\s*['"`]git['"`]\s*,/,
  /\?\?\s*['"`]git['"`]/,
  /\b(file|cmd|command)\s*:\s*['"`]git['"`]/,
  /\b(exec|execSync|spawnSync)\(\s*['"`]git\s/,
]
const DUMMY = 'dummy-test-value-not-a-secret' // test-only
const SECRET_KEYS = ['WEBTERM_TOKEN', 'NODETERM_NODE_TOKEN', 'TELEGRAM_BOT_TOKEN'] as const
const saved = Object.fromEntries(SECRET_KEYS.map((k) => [k, process.env[k]]))
const tmp = mkdtempSync(join(tmpdir(), 'webterm-gitexec-'))
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } // test-only isolation

afterAll(() => {
  for (const k of SECRET_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  rmSync(tmp, { recursive: true, force: true })
})

function serverSources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return serverSources(p)
    return p.endsWith('.ts') && !TEST_FILE.test(p) && p !== HELPER ? [p] : []
  })
}

/** A committed repo whose config runs `drv.sh` (touches `.git/ran`) via fsmonitor/diff.external/textconv. */
function hostileRepo(): { dir: string; marker: string } {
  const dir = mkdtempSync(join(tmp, 'repo-'))
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { env: GIT_ENV })
  git('init', '-q')
  writeFileSync(join(dir, 'a.txt'), 'x\n')
  git('add', 'a.txt')
  git('commit', '-qm', 'init')
  const marker = join(dir, '.git', 'ran')
  const drv = join(dir, '.git', 'drv.sh')
  writeFileSync(drv, `#!/bin/sh\necho "root=\${WEBTERM_TOKEN:+set}" >> ${JSON.stringify(marker)}\nexit 1\n`)
  chmodSync(drv, 0o755)
  git('config', 'core.fsmonitor', drv)
  git('config', 'diff.external', drv)
  git('config', 'diff.evil.textconv', drv)
  writeFileSync(join(dir, '.gitattributes'), '*.txt diff=evil\n')
  writeFileSync(join(dir, 'a.txt'), 'y\n')
  return { dir, marker }
}

describe('gitExec policy', () => {
  test('no server source spawns git outside gitExec.ts', () => {
    const offenders = serverSources(SERVER).flatMap((file) =>
      readFileSync(file, 'utf8').split('\n').flatMap((line, i) =>
        DIRECT_GIT.some((re) => re.test(line)) ? [`${relative(SERVER, file)}:${i + 1}: ${line.trim()}`] : []))
    expect(offenders).toEqual([])
  })

  test('argv turns fsmonitor and hooks off, diff drivers off on diff/show/log; userHooks keeps hooks', () => {
    expect(gitCommand(['-C', '/r', 'status']).args).toEqual(['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-C', '/r', 'status'])
    expect(gitCommand(['-C', '/r', 'diff', '--', 'a']).args.slice(4)).toEqual(['-C', '/r', 'diff', '--no-ext-diff', '--no-textconv', '--', 'a'])
    expect(gitCommand(['commit', '-F', '-'], { userHooks: true }).args).toEqual(['-c', 'core.fsmonitor=false', 'commit', '-F', '-'])
  })

  test('env drops root/node/bot tokens and inherited repo redirects', () => {
    const env = gitEnv({}, { PATH: '/bin', WEBTERM_TOKEN: DUMMY, NODETERM_NODE_TOKEN: DUMMY, TELEGRAM_BOT_TOKEN: DUMMY, GIT_DIR: '/x', GIT_WORK_TREE: '/y' })
    expect(Object.values(env)).not.toContain(DUMMY)
    expect('GIT_DIR' in env).toBe(false)
    expect('GIT_WORK_TREE' in env).toBe(false)
    expect(env.GIT_TERMINAL_PROMPT).toBe('0')
  })
})

describe('repo-local git drivers never run from background git callers', () => {
  for (const k of SECRET_KEYS) process.env[k] = DUMMY
  const cases: [string, (dir: string) => Promise<unknown>][] = [
    ['checkpoint snapshotTree', async (dir) => {
      const { repoOf, snapshotTree } = await import('./checkpoint/checkpoint.git')
      await snapshotTree((await repoOf(dir))!)
    }],
    ['routines gitTreeState', async (dir) => (await import('./routines/routinesRuntime')).gitTreeState(dir)],
    ['gitInfo collectGitInfo', async (dir) => (await import('./gitInfo')).collectGitInfo([dir])],
    ['repoHygiene guardWorkspaceRepos', async (dir) => (await import('./repoHygiene')).guardWorkspaceRepos([{ id: 'w', cwd: dir }])],
    ['gitDiff fileDiff', async (dir) => (await import('./gitDiff')).fileDiff(dir, 'a.txt')],
    ['fsGit gitMarks', async (dir) => (await import('./fsGit')).gitMarks(dir)],
  ]
  for (const [name, run] of cases) {
    test(name, async () => {
      const { dir, marker } = hostileRepo()
      await run(dir)
      expect(existsSync(marker)).toBe(false)
    }, 30_000)
  }
})
