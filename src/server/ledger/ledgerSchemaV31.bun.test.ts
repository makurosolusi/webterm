// v31: policy_grant.workspace_id is added to an existing DB, old rules read as "every workspace", re-applying is a no-op.
import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createPolicyStore } from '../policy/policy.store'
import { evaluate } from '../policy/policy.model'
import { MIGRATIONS } from './ledgerSchema'
import { LATEST_VERSION, migrate } from './migration'
import { applyV31 } from './ledgerSchemaV31'

test('an existing rule survives v31 unscoped, a new rule keeps its workspace, applying twice is safe', () => {
  const db = new Database(':memory:')
  migrate(db, MIGRATIONS.filter((m) => m.version <= 30))
  db.exec(`INSERT INTO policy_grant (id, subject, capability, scope, effect, origin, created_by, created_at, ord)
    VALUES ('old', 'node:*', 'secret.run', '*', 'allow', 'human-ui', 'human-ui', 0, 1)`)
  expect(migrate(db)).toBe(LATEST_VERSION)
  applyV31(db)
  const store = createPolicyStore(db, () => 1)
  const human = () => store.grants().filter((g) => g.origin !== 'builtin')
  expect(store.grants().every((g) => g.workspaceId === null)).toBe(true)
  expect(human()).toMatchObject([{ id: 'old', workspaceId: null }])
  const q = { principal: 'node:a1', capability: 'secret.run', workspaceId: 'w9', now: 1 }
  expect(evaluate(store.grants(), q).ruleId).toBe('old')
  store.insertGrant({ subject: 'node:*', capability: 'secret.run', scope: '*', workspaceId: 'w1', effect: 'deny', expiresAt: null, origin: 'human-ui', createdBy: 'human-ui' })
  expect(human().map((g) => g.workspaceId)).toEqual([null, 'w1'])
  expect(evaluate(store.grants(), q).ruleId).toBe('old')
  expect(evaluate(store.grants(), { ...q, workspaceId: 'w1' }).effect).toBe('deny')
})
