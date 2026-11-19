// Test-only helpers: a tiny real git repo in a tmp dir and a ledger with the real schema (bun:sqlite).
import { Database } from 'bun:sqlite'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { MIGRATIONS } from '../ledger/ledgerSchema'

// test-only values
export const FIXTURE_SECRET = 'ZZ_FIXTURE_NOT_A_REAL_SECRET_VALUE_12345'
export const NOW = 1_700_000_000_000
// Per-test timeout for tests that run real `git commit`: CI runners have slow I/O and the default 5s flakes.
export const GIT_SLOW_TEST_TIMEOUT_MS = 30_000

/** Runs git in `dir` with a fixed identity. */
export function sh(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' })
}

/** Writes files (relative path -> content) under `dir`. */
export function put(dir: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), text)
  }
}

/** A committed repo: three modules with imports, docs, and force-added secret/dependency files. */
export function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kbfx-'))
  sh(dir, 'init', '-q')
  put(dir, {
    'src/a.ts': "import { shared } from './b'\nexport function alpha() { return shared() }\n",
    'src/b.ts': 'export function shared() { return 1 }\nexport const BETA = 2\n',
    'src/c.ts': "import { shared } from './b.js'\nexport const gamma = shared()\n",
    'README.md': '# Fixture\n\nIntro text.\n\n## Zebraquokka\n\nThe zebraquokka subsystem handles everything.\n',
    'CLAUDE.md': `# Rules\n\nAPI_KEY=${FIXTURE_SECRET}\n`,
    'package.json': '{"name":"fx","scripts":{"test":"vitest run"},"dependencies":{"left-pad":"1.0.0"}}',
    '.env': `SECRET=${FIXTURE_SECRET}\n`,
    '.env.local': `SECRET=${FIXTURE_SECRET}\n`,
    'config/server.pem': `-----BEGIN PRIVATE KEY-----\n${FIXTURE_SECRET}\n-----END PRIVATE KEY-----\n`,
    'node_modules/dep/index.js': 'export const depSymbol = 1\n',
    'dist/out.js': 'export const distSymbol = 1\n',
  })
  sh(dir, 'add', '-f', '.')
  sh(dir, 'commit', '-q', '-m', 'init')
  return dir
}

/** Ledger on the real schema with one project rooted at `root`. */
export function makeLedger(root: string, projectId = 'p1'): Database {
  const db = new Database(':memory:')
  for (const m of MIGRATIONS) m.up(db)
  db.query('INSERT INTO project (id, workspace_id, name, path, status, priority, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)').run(projectId, `w-${projectId}`, 'Fixture', root, 'active', 0, NOW, NOW)
  return db
}
