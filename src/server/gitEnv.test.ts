// What a git child process sees when webterm runs git (sec-208-2). A repo-local `core.fsmonitor`
// script is code from the repo: it must not run at all for file decorations or git info. Where a
// hook legitimately runs (the user's own "New project" commit, `userHooks`), it must see the
// filtered env: no root token, no node token, no bot token.
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { gitMarks } from './fsGit'
import { collectGitInfo } from './gitInfo'
import { createProject } from './workspaceCreate/workspaceCreate'

const ROOT = 'ROOTSENTINEL_git_0123456789' // test-only fixture
const SECRET_KEYS = ['WEBTERM_TOKEN', 'NODETERM_NODE_TOKEN', 'TELEGRAM_BOT_TOKEN'] as const
const ENV_KEYS = [...SECRET_KEYS, 'GIT_CONFIG_GLOBAL', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'] as const
const dir = mkdtempSync(join(tmpdir(), 'webterm-gitenv-'))
const repo = join(dir, 'repo')
const marker = join(dir, 'fsmonitor.ran')
const dump = join(dir, 'hook-env.out')
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))

mkdirSync(repo)
execFileSync('git', ['init', '-q', repo])
const fsmonitor = join(dir, 'fsmonitor.sh')
writeFileSync(fsmonitor, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 1\n`)
chmodSync(fsmonitor, 0o700)
execFileSync('git', ['-C', repo, 'config', 'core.fsmonitor', fsmonitor])
writeFileSync(join(repo, 'a.txt'), 'x')

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  rmSync(dir, { recursive: true, force: true })
})

describe('git subprocess safety', () => {
  for (const [name, run] of [
    ['fsGit.gitMarks', () => gitMarks(repo)],
    ['gitInfo.collectGitInfo', () => collectGitInfo([repo])],
  ] as const) {
    it(`${name} never runs a repo-local core.fsmonitor`, async () => {
      rmSync(marker, { force: true })
      await run()
      expect(existsSync(marker)).toBe(false)
    })
  }

  it('a user hook (New project commit) runs without WEBTERM_*/NODETERM_*/bot secrets', async () => {
    const hooks = join(dir, 'hooks')
    mkdirSync(hooks, { recursive: true })
    writeFileSync(join(hooks, 'pre-commit'), `#!/bin/sh\nenv > ${JSON.stringify(dump)}\n`)
    chmodSync(join(hooks, 'pre-commit'), 0o700)
    const globalConfig = join(dir, 'gitconfig') // test-only: user-level hooksPath, isolated from ~/.gitconfig
    writeFileSync(globalConfig, `[core]\n\thooksPath = ${hooks}\n`)
    process.env.GIT_CONFIG_GLOBAL = globalConfig
    for (const k of ['GIT_AUTHOR_NAME', 'GIT_COMMITTER_NAME']) process.env[k] = 't'
    for (const k of ['GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_EMAIL']) process.env[k] = 't@t'
    for (const k of SECRET_KEYS) process.env[k] = ROOT
    await createProject({ parent: dir, name: 'proj' }, { dataDir: join(dir, 'data') })
    const env = readFileSync(dump, 'utf8')
    expect(env).toContain('PATH=') // the hook really ran with an env
    expect(env.includes(ROOT)).toBe(false)
    expect(env).not.toMatch(/^(WEBTERM|NODETERM)_/m)
  })
})
