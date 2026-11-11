import { describe, expect, it } from 'vitest'
import { findingFingerprint, lineKey } from './healthFingerprint'
import { resolveSpecifier, tsconfigAliases, unreferencedFindings } from './healthRules.imports'
import { countLines, sizeFindings } from './healthRules.size'
import { emptyCatchFindings, todoFindings, tokenize } from './healthRules.text'

const lines = (n: number) => 'x\n'.repeat(n)

describe('file_size', () => {
  it('flags over the hard line limit as high with measured evidence', () => {
    const [f] = sizeFindings('src/big.ts', lines(612))
    expect(f).toMatchObject({ rule: 'file_size', severity: 'high', line: null, source: 'Rule 8 (global CLAUDE.md)' })
    expect(f?.evidence).toBe('612 lines, 1 224 chars (limit 500 lines / 20 000 chars)')
  })
  it('flags over the char limit as high', () => {
    expect(sizeFindings('src/wide.ts', 'a'.repeat(21_403))[0]?.severity).toBe('high')
  })
  it('flags approaching (>=80%) as low, below that nothing', () => {
    expect(sizeFindings('src/a.ts', lines(400))[0]?.severity).toBe('low')
    expect(sizeFindings('src/a.ts', lines(399))).toEqual([])
  })
  it('uses the 400-line limit for tests (medium) and 80% of it for low', () => {
    expect(sizeFindings('src/a.test.ts', lines(450))[0]?.severity).toBe('medium')
    expect(sizeFindings('src/a.test.ts', lines(330))[0]?.severity).toBe('low')
    expect(sizeFindings('src/a.test.ts', lines(600))[0]?.severity).toBe('high')
  })
  it('exempts migrations, fixtures, test utils, generated and non-source files', () => {
    for (const p of ['src/ledger/ledgerSchemaV30.ts', 'db/migrations/001.ts', 'test/fixtures/a.ts', 'src/x.testutil.ts', 'src/api.generated.ts', 'README.md']) {
      expect(sizeFindings(p, lines(900))).toEqual([])
    }
  })
  it('counts lines like an editor', () => {
    expect(countLines('')).toBe(0)
    expect(countLines('a\nb')).toBe(2)
    expect(countLines('a\nb\n')).toBe(2)
  })
})

describe('todo_no_context', () => {
  it('flags bare TODO/FIXME/HACK/XXX comments with line and quoted evidence', () => {
    const src = 'const a = 1\n// TODO: fix this\n/* FIXME later */\n// HACK\nconst b = 2 // XXX odd\n'
    const found = todoFindings('src/a.ts', src)
    expect(found.map((f) => f.line)).toEqual([2, 3, 4, 5])
    expect(found[0]).toMatchObject({ severity: 'low', confidence: 'high', evidence: '// TODO: fix this', source: 'Rule 17 (global CLAUDE.md)' })
  })
  it('accepts scope, issue number, ticket or URL context', () => {
    const src = '// TODO(auth): refresh\n// TODO #42\n// FIXME see issue #7\n// TODO ABC-123\n// TODO https://x.test/1\n'
    expect(todoFindings('src/a.ts', src)).toEqual([])
  })
  it('ignores TODO inside strings and template literals, and words like TODOS', () => {
    const src = "const s = 'TODO: not a comment'\nconst t = `// TODO ${x} still text`\n// TODOS are fine\n"
    expect(todoFindings('src/a.ts', src)).toEqual([])
  })
  it('reports the right line inside a multi-line block comment', () => {
    expect(todoFindings('src/a.ts', '/**\n * docs\n * TODO tidy\n */\n')[0]?.line).toBe(3)
  })
  it('checks comment markers in non-JS sources and skips docs', () => {
    expect(todoFindings('app/main.py', 'x = 1  # TODO later\n')[0]?.line).toBe(1)
    expect(todoFindings('README.md', '- TODO write docs\n')).toEqual([])
  })
  it('evidence is capped at 200 chars', () => {
    expect(todoFindings('src/a.ts', `// TODO ${'y'.repeat(400)}`)[0]?.evidence.length).toBe(200)
  })
})

describe('empty_catch', () => {
  it('truly empty is medium, comment-only is low', () => {
    const src = 'try { a() } catch (e) {}\ntry { b() } catch {\n}\ntry { c() } catch (e) { /* ignore */ }\n'
    const found = emptyCatchFindings('src/a.ts', src)
    expect(found.map((f) => [f.line, f.severity])).toEqual([[1, 'medium'], [2, 'medium'], [4, 'low']])
    expect(found[0]?.source).toBe('Rule 11 (global CLAUDE.md)')
  })
  it('does not flag a catch with a statement', () => {
    expect(emptyCatchFindings('src/a.ts', 'try { a() } catch (e) { log(e) }')).toEqual([])
  })
  it('never matches inside strings, templates, regex or comments', () => {
    const src = [
      "const s = 'catch {}'",
      'const d = "catch (e) {}"',
      'const t = `x ${y} catch {} ${`catch {}`}`',
      'const r = /catch {}/',
      '// catch {}',
      'const q = a / b; const z = c / d',
    ].join('\n')
    expect(emptyCatchFindings('src/a.ts', src)).toEqual([])
  })
  it('resumes code after a template with nested braces', () => {
    const src = 'const t = `${ {a: 1}.a }`\ntry { x() } catch {}\n'
    expect(emptyCatchFindings('src/a.ts', src).map((f) => f.line)).toEqual([2])
  })
  it('only applies to JS/TS', () => {
    expect(emptyCatchFindings('a.py', 'catch {}')).toEqual([])
  })
  it('tokenize keeps length and newlines', () => {
    const src = "a('x')\n// c\n"
    expect(tokenize(src).code).toHaveLength(src.length)
    expect(tokenize(src).code.split('\n')).toHaveLength(3)
  })
})

describe('fingerprint', () => {
  it('stays stable when lines shift above the finding', () => {
    const before = todoFindings('src/a.ts', '// TODO tidy\n')[0]?.fingerprint
    const after = todoFindings('src/a.ts', 'const x = 1\n\n\n//   TODO   tidy\n')[0]?.fingerprint
    expect(after).toBe(before)
  })
  it('distinguishes repeated identical lines by occurrence', () => {
    const [a, b] = todoFindings('src/a.ts', '// TODO tidy\n// TODO tidy\n')
    expect(a?.fingerprint).not.toBe(b?.fingerprint)
    expect(lineKey(['x', ' x ', 'x'], 2)).toBe('x#2')
  })
  it('differs by rule and file; whole-file rules use an empty key', () => {
    expect(findingFingerprint('file_size', 'a.ts')).toMatch(/^[0-9a-f]{40}$/)
    expect(findingFingerprint('file_size', 'a.ts')).not.toBe(findingFingerprint('file_size', 'b.ts'))
    expect(sizeFindings('a.ts', lines(600))[0]?.fingerprint).toBe(findingFingerprint('file_size', 'a.ts'))
  })
})

describe('unreferenced_module', () => {
  const graph = (files: Record<string, string>) => unreferencedFindings(new Map(Object.entries(files)))

  it('resolves relative specifiers with extension, .js→.ts and index probing', () => {
    const set = new Set(['src/a.ts', 'src/b.tsx', 'src/lib/index.ts', 'src/c.ts'])
    expect(resolveSpecifier('src/a.ts', './b', set)).toBe('src/b.tsx')
    expect(resolveSpecifier('src/a.ts', './c.js', set)).toBe('src/c.ts')
    expect(resolveSpecifier('src/a.ts', './lib', set)).toBe('src/lib/index.ts')
    expect(resolveSpecifier('src/a.ts', '../../x', set)).toBeNull()
    expect(resolveSpecifier('src/a.ts', 'react', set)).toBeNull()
  })
  it('resolves tsconfig path aliases', () => {
    const aliases = tsconfigAliases('{\n  // c\n "compilerOptions": { "paths": { "@/*": ["./src/client/*"] }, } }')
    expect(resolveSpecifier('src/client/x.ts', '@/ui/btn', new Set(['src/client/ui/btn.tsx']), aliases)).toBe('src/client/ui/btn.tsx')
    expect(tsconfigAliases('not json')).toEqual([])
  })
  it('flags an orphan module at low/medium, never high', () => {
    const found = graph({
      'src/main.ts': "import { a } from './a'\nexport * from './b.js'\nconst w = new URL('./worker.ts', import.meta.url)\nawait import('./lazy')\nrequire('./cjs')\n",
      'src/a.ts': '', 'src/b.ts': '', 'src/worker.ts': '', 'src/lazy.ts': '', 'src/cjs.js': '', 'src/orphan.ts': '',
      'package.json': '{"main":"src/main.ts"}',
    })
    expect(found.map((f) => f.file)).toEqual(['src/orphan.ts'])
    expect(found[0]).toMatchObject({ severity: 'low', confidence: 'medium', line: null, evidence: 'no file imports this module (checked 7 files)' })
  })
  it('flags a module only tests import', () => {
    const found = graph({ 'src/x.ts': '', 'src/x.test.ts': "import { x } from './x'", 'src/index.ts': '' })
    expect(found.map((f) => [f.file, f.title])).toEqual([['src/x.ts', 'Module is only imported by tests']])
  })
  it('does not flag test-support modules (fakes, fixtures, harnesses) that tests import', () => {
    const found = graph({
      'src/a.test.ts': "import './x.fake'\nimport './chatHarness'\nimport './fixtures/data'\n",
      'src/x.fake.ts': "import './y'\n", 'src/y.ts': '', 'src/chatHarness.ts': '', 'src/fixtures/data.ts': '',
      'src/unused.testutil.ts': '', 'src/index.ts': '',
    })
    expect(found.map((f) => [f.file, f.title])).toEqual([
      ['src/y.ts', 'Module is only imported by tests'],
      ['src/unused.testutil.ts', 'Module is not imported anywhere'],
    ])
  })
  it('follows relative html script src and skips public assets', () => {
    expect(graph({ 'src/m/index.html': '<script type="module" src="../mobile/main.tsx"></script>', 'src/mobile/main.tsx': '', 'src/public/sw.js': '' })).toEqual([])
  })
  it('excludes entry points: package.json scripts, configs, top index, tests, d.ts, string-literal paths, html script', () => {
    const found = graph({
      'package.json': '{"scripts":{"dev":"bun scripts/dev.ts"}}',
      'scripts/dev.ts': '',
      'vite.config.ts': '',
      'src/index.ts': '',
      'src/server/index.ts': '',
      'src/a.bun.test.ts': '',
      'src/types.d.ts': '',
      'src/loader.ts': "const p = 'src/plugin'\n",
      'src/plugin.ts': '',
      'index.html': '<script type="module" src="/src/client/main.tsx"></script>',
      'src/client/main.tsx': '',
    })
    expect(found.map((f) => f.file)).toEqual(['src/loader.ts'])
  })
})
