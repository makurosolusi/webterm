// What a git child process sees when webterm runs git (file decorations + git info). A repo-local
// `core.fsmonitor` script stands in for any repo hook: git runs it during `status` with the env
// webterm passed, and it dumps that env to a file. Secrets of the server must not be in it.
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { gitMarks } from './fsGit'
import { collectGitInfo } from './gitInfo'

const ROOT = 'ROOTSENTINEL_git_0123456789' // test-only fixture
const dir = mkdtempSync(join(tmpdir(), 'webterm-gitenv-'))
const dump = join(dir, 'env.out')
const saved = { t: process.env.WEBTERM_TOKEN, n: process.env.NODETERM_NODE_TOKEN, b: process.env.TELEGRAM_BOT_TOKEN }

execFileSync('git', ['init', '-q', dir])
const hook = join(dir, 'fsmonitor.sh')
writeFileSync(hook, `#!/bin/sh\nenv > ${JSON.stringify(dump)}\nexit 1\n`)
chmodSync(hook, 0o700)
execFileSync('git', ['-C', dir, 'config', 'core.fsmonitor', hook])
writeFileSync(join(dir, 'a.txt'), 'x')

afterAll(() => {
  for (const [k, v] of [['WEBTERM_TOKEN', saved.t], ['NODETERM_NODE_TOKEN', saved.n], ['TELEGRAM_BOT_TOKEN', saved.b]] as const) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  rmSync(dir, { recursive: true, force: true })
})

function seenEnv(): string {
  return readFileSync(dump, 'utf8')
}

describe('git subprocess env', () => {
  for (const [name, run] of [
    ['fsGit.gitMarks', () => gitMarks(dir)],
    ['gitInfo.collectGitInfo', () => collectGitInfo([dir])],
  ] as const) {
    it(`${name} hides WEBTERM_*/NODETERM_*/bot secrets from git children`, async () => {
      process.env.WEBTERM_TOKEN = ROOT
      process.env.NODETERM_NODE_TOKEN = ROOT
      process.env.TELEGRAM_BOT_TOKEN = ROOT
      rmSync(dump, { force: true })
      await run()
      const env = seenEnv()
      expect(env).toContain('PATH=') // the hook really ran with an env
      expect(env.includes(ROOT)).toBe(false)
      expect(env).not.toMatch(/^(WEBTERM|NODETERM)_/m)
    })
  }
})
