// Auto-done is on for a NEW project (most capable by default); a project that already exists keeps its value, and an
// explicit choice always sticks. In-memory ledger only.
import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { projectRepository } from '../../ledger/ledgerEntity'
import { migrate } from '../../ledger/migration'
import { readAutoDone, writeAutoDone } from './workSettings'

test('new project = auto-done on; existing row untouched; explicit off sticks', () => {
  const db = new Database(':memory:')
  migrate(db)
  // An install's existing project (created before this default): stays as stored.
  db.exec(`INSERT INTO project (id, workspace_id, name, path, created_at, updated_at) VALUES ('old', 'w-old', 'old', '/tmp/old', 0, 0)`)
  const repo = projectRepository({ db, now: () => 1 })
  repo.createProject({ id: 'new', workspaceId: 'w-new', name: 'new', path: '/tmp/new' })
  expect(readAutoDone(db, 'new')).toBe(true)
  expect(readAutoDone(db, 'old')).toBe(false)
  expect(writeAutoDone(db, 'new', false, 2)).toBe(true)
  expect(readAutoDone(db, 'new')).toBe(false)
})
