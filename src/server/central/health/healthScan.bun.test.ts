import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { put, sh } from '../../knowledge/knowledgeFixture.testutil'
import { scanProject } from './healthScan'

const dirs: string[] = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

/** A temp git repo with `files` added to the index (no commit needed for ls-files). */
function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'health-'))
  dirs.push(dir)
  sh(dir, 'init', '-q')
  put(dir, files)
  sh(dir, 'add', '-A', '-f')
  return dir
}

describe('scanProject', () => {
  test('finds size, TODO, empty catch and orphan modules; entry points and strings are not findings', async () => {
    const dir = repo({
      'package.json': '{"scripts":{"dev":"bun src/server/main.ts"}}',
      'src/server/main.ts': "import { a } from './a'\nconst s = 'catch {} TODO later'\n",
      'src/server/a.ts': `export const a = 1\n// TODO tidy\ntry { a } catch (e) {}\n${'x\n'.repeat(600)}`,
      'src/server/orphan.ts': 'export const o = 1\n',
      'src/server/main.test.ts': "import './main'\n",
      'vite.config.ts': 'export default {}\n',
    })
    const r = await scanProject(dir)
    expect(r.truncated).toBe(false)
    expect(r.filesScanned).toBe(6)
    expect(r.rules).toEqual(['file_size', 'todo_no_context', 'empty_catch', 'unreferenced_module'])
    const got = r.drafts.map((d) => `${d.rule}:${d.file}:${d.line ?? '-'}:${d.severity}`).sort()
    expect(got).toEqual([
      'empty_catch:src/server/a.ts:3:medium',
      'file_size:src/server/a.ts:-:high',
      'todo_no_context:src/server/a.ts:2:low',
      'unreferenced_module:src/server/orphan.ts:-:low',
    ])
  })

  test('skips binaries, vendor dirs, minified files, lockfiles and files over maxBytesPerFile', async () => {
    const dir = repo({
      'node_modules/dep/index.js': '// TODO vendor\n',
      'dist/app.js': '// TODO built\n',
      'src/app.min.js': '// TODO min\n',
      'bun.lock': '// TODO lock\n',
      'src/huge.ts': `// TODO huge\n${'y'.repeat(5000)}`,
      'src/ok.ts': '// TODO keep\n',
    })
    writeFileSync(join(dir, 'src/blob.ts'), Buffer.concat([Buffer.from('// TODO bin\n'), Buffer.from([0, 1, 2])]))
    sh(dir, 'add', '-A', '-f')
    const r = await scanProject(dir, { maxBytesPerFile: 1000 })
    expect(r.filesScanned).toBe(1)
    expect(r.drafts.filter((d) => d.rule === 'todo_no_context').map((d) => d.file)).toEqual(['src/ok.ts'])
  })

  test('maxFiles cap truncates cleanly and drops the graph rule', async () => {
    const dir = repo({ 'src/a.ts': '// TODO a\n', 'src/b.ts': '// TODO b\n', 'src/c.ts': '// TODO c\n' })
    const r = await scanProject(dir, { maxFiles: 2 })
    expect(r.truncated).toBe(true)
    expect(r.filesScanned).toBe(2)
    expect(r.rules).toEqual(['file_size', 'todo_no_context', 'empty_catch'])
    expect(r.drafts.every((d) => d.rule !== 'unreferenced_module')).toBe(true)
    expect(r.drafts).toHaveLength(2)
  })

  test('deadline cap truncates', async () => {
    const dir = repo({ 'src/a.ts': '', 'src/b.ts': '' })
    let t = 0
    const r = await scanProject(dir, { deadlineMs: 10, now: () => (t += 6) })
    expect(r.truncated).toBe(true)
    expect(r.filesScanned).toBe(1)
  })

  test('not a git repo throws with context', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'health-nogit-'))
    dirs.push(dir)
    let message = ''
    try { await scanProject(dir) } catch (err) { message = (err as Error).message }
    expect(message).toMatch(/health scan: git ls-files failed in .*health-nogit-/)
  })

  test('fingerprints survive lines inserted above the finding', async () => {
    const dir = repo({ 'src/index.ts': '// TODO tidy\ntry { x() } catch {}\n' })
    const first = (await scanProject(dir)).drafts
    writeFileSync(join(dir, 'src/index.ts'), 'const a = 1\nconst b = 2\n// TODO tidy\ntry { x() } catch {}\n')
    const second = (await scanProject(dir)).drafts
    expect(second.map((d) => d.line)).toEqual(first.map((d) => (d.line as number) + 2))
    expect(second.map((d) => d.fingerprint)).toEqual(first.map((d) => d.fingerprint))
  })
})
