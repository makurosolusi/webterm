// Secrets guard against a REAL git repo in a temp dir: untracked secrets get a .gitignore block once,
// tracked ones are reported but left alone, and secret contents are never read.
import { test, expect } from 'bun:test'
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import npath from 'node:path'
import { promisify } from 'node:util'
import { GUARD_MARKER, guardWorkspaceRepos, hygieneFindings, hygieneRoute, HYGIENE_FINDINGS_PATH } from './repoHygiene'

const run = promisify(execFile)
const TEST_TIMEOUT_MS = 30_000
const GIT_ENV = {
  ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'webterm test', GIT_AUTHOR_EMAIL: 't@webterm.test',
  GIT_COMMITTER_NAME: 'webterm test', GIT_COMMITTER_EMAIL: 't@webterm.test',
}
const g = (cwd: string, ...args: string[]) => run('git', args, { cwd, env: GIT_ENV })

test('guards untracked secrets once, reports tracked ones, never reads contents', async () => {
  const dir = await fs.realpath(await fs.mkdtemp(npath.join(tmpdir(), 'webterm-hyg-')))
  try {
    await g(dir, 'init', '-q', '-b', 'main')
    await fs.writeFile(npath.join(dir, '.gitignore'), 'node_modules/') // no trailing newline on purpose
    await fs.writeFile(npath.join(dir, 'tracked.pem'), 'test-only\n')
    await g(dir, 'add', '.gitignore', 'tracked.pem')
    await g(dir, 'commit', '-q', '-m', 'init')
    for (const f of ['cookies.txt', '.env', 'id_rsa']) await fs.writeFile(npath.join(dir, f), 'test-only\n')
    await fs.writeFile(npath.join(dir, '.env.example'), 'A=\n')
    // Unreadable: any attempt to read secret content would fail the scan and drop the findings.
    for (const f of ['cookies.txt', '.env', 'id_rsa', 'tracked.pem']) await fs.chmod(npath.join(dir, f), 0o000)

    const first = await guardWorkspaceRepos([{ id: 'ws1', cwd: dir }, { id: 'nocwd' }])
    const gi = await fs.readFile(npath.join(dir, '.gitignore'), 'utf8')
    expect(gi).toBe(`node_modules/\n\n${GUARD_MARKER}\n.env\n*cookies*.txt\nid_rsa*\n`)
    expect(first.filter((f) => f.action === 'ignored').map((f) => f.pattern).sort()).toEqual(['*cookies*.txt', '.env', 'id_rsa*'])
    expect(first).toEqual(expect.arrayContaining([
      { workspaceId: 'ws1', path: npath.join(dir, 'tracked.pem'), pattern: '*.pem', action: 'tracked' },
      { workspaceId: 'ws1', path: npath.join(dir, '.env'), pattern: '.env', action: 'ignored' },
    ]))
    expect(first.some((f) => f.path.endsWith('.env.example'))).toBe(false)
    expect(hygieneRoute(HYGIENE_FINDINGS_PATH, 'GET')).toEqual({ status: 200, body: hygieneFindings() })
    // A per-workspace run (create / cwd change) keeps other workspaces' findings.
    await guardWorkspaceRepos([{ id: 'ws2' }])
    expect(hygieneFindings()).toEqual(first)

    // Tracked file untouched: still tracked, mode unchanged; untracked secrets now ignored.
    expect((await g(dir, 'ls-files', 'tracked.pem')).stdout.trim()).toBe('tracked.pem')
    expect((await fs.stat(npath.join(dir, 'tracked.pem'))).mode & 0o777).toBe(0)
    expect((await g(dir, 'ls-files', '--others', '--exclude-standard')).stdout.trim()).toBe('.env.example')

    // Idempotent: a second run adds nothing.
    await guardWorkspaceRepos([{ id: 'ws1', cwd: dir }])
    expect(await fs.readFile(npath.join(dir, '.gitignore'), 'utf8')).toBe(gi)

    // A new secret lands inside the existing block, not after the user's own rules.
    await fs.writeFile(npath.join(dir, '.gitignore'), `${gi}\n# user rule\n*.tmp\n`)
    await fs.writeFile(npath.join(dir, '.env.local'), 'test-only\n')
    await guardWorkspaceRepos([{ id: 'ws1', cwd: dir }])
    expect(await fs.readFile(npath.join(dir, '.gitignore'), 'utf8')).toBe(
      `node_modules/\n\n${GUARD_MARKER}\n.env\n*cookies*.txt\nid_rsa*\n.env.*\n!.env.example\n!.env.sample\n!.env.template\n\n# user rule\n*.tmp\n`)
    expect((await g(dir, 'ls-files', '--others', '--exclude-standard')).stdout.trim()).toBe('.env.example')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}, TEST_TIMEOUT_MS)

test('non-repo cwd yields no findings and writes nothing', async () => {
  const dir = await fs.mkdtemp(npath.join(tmpdir(), 'webterm-hyg-plain-'))
  try {
    await fs.writeFile(npath.join(dir, '.env'), 'test-only\n')
    expect(await guardWorkspaceRepos([{ id: 'ws', cwd: dir }])).toEqual([])
    expect(await fs.readdir(dir)).toEqual(['.env'])
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}, TEST_TIMEOUT_MS)
