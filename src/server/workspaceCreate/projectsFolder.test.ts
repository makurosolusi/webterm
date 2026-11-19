// Default projects folder, its validation, next free name, wrong-place warnings, reveal argv and the
// already-cloned scan, all against temp dirs: HOME and the data dir are injected, never the real ones.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { findExistingClone, readOriginUrl } from './alreadyCloned'
import { normalizeRepoUrl } from './cloneUrl'
import { preflight } from './preflight'
import {
  builtinProjectsFolder, nextFreeName, placeWarnings, projectsFolder, projectsFolderError, revealPath, suggestedParent, type FolderEnv,
} from './projectsFolder'

let tmp: string
let env: FolderEnv
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'wspf-')))
  env = { home: join(tmp, 'home'), dataDir: join(tmp, 'home', '.webterm-server'), configured: '' }
  mkdirSync(env.dataDir, { recursive: true })
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

/** A folder whose .git/config names `url` as origin. test-only */
function fakeClone(dir: string, url: string): void {
  mkdirSync(join(dir, '.git'), { recursive: true })
  writeFileSync(join(dir, '.git', 'config'), `[core]\n\tbare = false\n[remote "upstream"]\n\turl = https://x.org/other\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`)
}

describe('default projects folder', () => {
  it('is ~/webterm/projects, resolved without creating it', async () => {
    expect(await projectsFolder(env)).toBe(join(env.home, 'webterm', 'projects'))
    expect(await suggestedParent('', env)).toBe(join(env.home, 'webterm', 'projects'))
    expect(() => realpathSync(join(env.home, 'webterm'))).toThrow()
  })

  it('never sits inside the data dir', () => {
    expect(builtinProjectsFolder(env.home, join(env.home, 'webterm'))).toBe(join(env.home, 'webterm-projects'))
  })

  it('uses a valid configured folder, falls back when the stored one is invalid', async () => {
    expect(await projectsFolder({ ...env, configured: join(tmp, 'code') })).toBe(join(tmp, 'code'))
    expect(await projectsFolder({ ...env, configured: 'relative' })).toBe(join(env.home, 'webterm', 'projects'))
    expect(await projectsFolder({ ...env, configured: join(env.dataDir, 'p') })).toBe(join(env.home, 'webterm', 'projects'))
  })

  it('remembered parent is used while it is a folder, else silently the default', async () => {
    const remembered = join(tmp, 'last')
    expect(await suggestedParent(remembered, env)).toBe(join(env.home, 'webterm', 'projects')) // gone
    writeFileSync(remembered, 'file')
    expect(await suggestedParent(remembered, env)).toBe(join(env.home, 'webterm', 'projects')) // a file
    rmSync(remembered)
    mkdirSync(remembered)
    expect(await suggestedParent(remembered, env)).toBe(remembered)
  })
})

describe('settings validation', () => {
  it('rejects relative, inside the data dir, and a file; accepts a missing folder', async () => {
    expect(await projectsFolderError('code/projects', env)).toMatch(/absolute/)
    expect(await projectsFolderError(env.dataDir, env)).toMatch(/data folder/)
    expect(await projectsFolderError(join(env.dataDir, 'x', 'y'), env)).toMatch(/data folder/)
    writeFileSync(join(tmp, 'f'), '')
    expect(await projectsFolderError(join(tmp, 'f'), env)).toMatch(/file/)
    expect(await projectsFolderError(join(tmp, 'not', 'yet'), env)).toBeNull()
  })

  it('sees through a symlink into the data dir', async () => {
    const { symlinkSync } = await import('node:fs')
    symlinkSync(env.dataDir, join(tmp, 'link'))
    expect(await projectsFolderError(join(tmp, 'link', 'p'), env)).toMatch(/data folder/)
  })
})

describe('next free name', () => {
  it('skips non-empty name-N folders, reuses an empty one', async () => {
    for (const n of ['app', 'app-2']) { mkdirSync(join(tmp, n)); writeFileSync(join(tmp, n, 'x'), '') }
    expect(await nextFreeName(tmp, 'app')).toBe('app-3')
    mkdirSync(join(tmp, 'app-3'))
    expect(await nextFreeName(tmp, 'app')).toBe('app-3') // empty is fine
    writeFileSync(join(tmp, 'app-3', 'x'), '')
    expect(await nextFreeName(tmp, 'app')).toBe('app-4')
  })
})

describe('wrong-place warnings', () => {
  it('inside another repo and directly in home warn; inside the data dir blocks', async () => {
    mkdirSync(join(tmp, 'repo', '.git'), { recursive: true })
    const inRepo = await placeWarnings(join(tmp, 'repo', 'sub', 'new'), env)
    expect(inRepo).toEqual([{ code: 'inside_repo', blocking: false, message: expect.stringContaining(join(tmp, 'repo')) }])
    expect((await placeWarnings(join(env.home, 'proj'), env)).map((w) => w.code)).toEqual(['home'])
    expect(await placeWarnings(env.home, env)).toContainEqual(expect.objectContaining({ code: 'home' }))
    const data = await placeWarnings(join(env.dataDir, 'proj'), env)
    expect(data[0]).toMatchObject({ code: 'data_dir', blocking: true })
    expect(await placeWarnings(join(tmp, 'clean', 'proj'), env)).toEqual([])
  })
})

describe('reveal', () => {
  it('macOS runs open -R <path>, Linux xdg-open <parent>, as argv', async () => {
    const calls: [string, string[]][] = []
    const spawn = async (c: string, a: string[]) => { calls.push([c, a]) }
    await revealPath('/a/b c/proj', { platform: 'darwin', spawn })
    await revealPath('/a/b c/proj', { platform: 'linux', spawn })
    expect(calls).toEqual([['open', ['-R', '/a/b c/proj']], ['xdg-open', ['/a/b c']]])
  })

  it('refuses a URL: the file manager opener must never reach a browser', () => {
    const never = vi.fn(async () => undefined)
    expect(() => revealPath('https://example.com', { platform: 'darwin', spawn: never })).toThrow(/refusing to hand a URL/)
    expect(never).not.toHaveBeenCalled()
  })

  it('rejects with the command named when it cannot start', async () => {
    await expect(revealPath('/x', { platform: 'linux', spawn: async () => { throw new Error('Could not run xdg-open: ENOENT') } })).rejects.toThrow(/xdg-open/)
  })
})

describe('already cloned', () => {
  it('normalises https, ssh, scp and owner/repo forms of one repo to the same key', () => {
    const forms = ['https://github.com/Vercel/Next.js.git', 'https://github.com/vercel/next.js', 'https://user@github.com/vercel/next.js/',
      'git@github.com:vercel/next.js.git', 'ssh://git@github.com/vercel/next.js.git', 'ssh://git@GitHub.com:22/Vercel/next.js', 'vercel/next.js']
    expect(new Set(forms.map(normalizeRepoUrl))).toEqual(new Set(['github.com/vercel/next.js']))
    expect(normalizeRepoUrl('https://gitlab.com/vercel/next.js')).not.toBe('github.com/vercel/next.js')
    expect(normalizeRepoUrl('not a url')).toBeNull()
  })

  it('reads origin (not another remote) from .git/config', async () => {
    fakeClone(join(tmp, 'r'), 'git@github.com:o/r.git')
    expect(await readOriginUrl(join(tmp, 'r'))).toBe('git@github.com:o/r.git')
    expect(await readOriginUrl(tmp)).toBeNull()
  })

  it('matches a workspace folder and a child of a scanned dir across URL forms', async () => {
    fakeClone(join(tmp, 'ws'), 'https://github.com/o/a.git')
    fakeClone(join(tmp, 'projects', 'b-copy'), 'git@github.com:O/B.git')
    const ws = [{ path: join(tmp, 'ws'), workspaceId: 'w1' }]
    expect((await findExistingClone('o/a', ws, [])).match).toEqual({ path: join(tmp, 'ws'), workspaceId: 'w1' })
    expect((await findExistingClone('https://github.com/o/b', ws, [join(tmp, 'projects'), join(tmp, 'missing')])).match).toEqual({ path: join(tmp, 'projects', 'b-copy') })
    expect(await findExistingClone('o/none', ws, [join(tmp, 'projects')])).toEqual({ match: null, skipped: false })
  })

  it('skips the check when over budget instead of hanging', async () => {
    const t0 = Date.now()
    const out = await findExistingClone('o/a', [{ path: tmp }], [], { budgetMs: 50, readOrigin: () => new Promise(() => {}) })
    expect(out).toEqual({ match: null, skipped: true })
    expect(Date.now() - t0).toBeLessThan(1000)
  })

  it('checks at most `cap` folders', async () => {
    const seen: string[] = []
    const ws = Array.from({ length: 10 }, (_, i) => ({ path: join(tmp, `d${i}`) }))
    await findExistingClone('o/a', ws, [], { cap: 3, readOrigin: async (d) => { seen.push(d); return null } })
    expect(seen).toHaveLength(3)
  })
})

describe('preflight', () => {
  it('reports target, taken + suggestion, warnings and an existing clone', async () => {
    const parent = join(tmp, 'p')
    fakeClone(join(parent, 'r'), 'https://github.com/o/r.git')
    const out = await preflight({ parent, url: 'git@github.com:o/r.git' }, { env, workspaces: async () => [] })
    expect(out).toMatchObject({ target: join(parent, 'r'), taken: true, suggestion: 'r-2', warnings: [], existing: { path: join(parent, 'r') }, existingSkipped: false })
    const fresh = await preflight({ parent: env.home, name: 'new' }, { env, workspaces: async () => [] })
    expect(fresh).toMatchObject({ target: join(env.home, 'new'), taken: false, suggestion: null, existing: null })
    expect(fresh.warnings.map((w) => w.code)).toEqual(['home'])
  })
})
