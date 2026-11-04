// Production wiring for template.route.ts: the live workspace store, a second connection to the same
// webterm.db for the `app` rows (Db keeps its handle private), the ledger's routine store, and
// worktrees made with the setup script OFF (an imported template must not run a repo script).
import { db, openDb } from '../db'
import { isValidNodeToken } from '../hooksTokens'
import { ensureRoutines } from '../routines/routinesRuntime'
import { createWorkspaceWorktree, worktreeRoot } from '../workspaceWorktree'
import type { TemplatesDeps } from './template.route'
import { createTemplateStore, type TemplateStore } from './template.store'

let store: TemplateStore | null = null

export function productionTemplatesDeps(): TemplatesDeps {
  store ??= createTemplateStore(openDb())
  return {
    store,
    workspaces: db,
    routines: () => {
      const rt = ensureRoutines()
      return rt ? { list: () => rt.store.list(), create: (input) => { const r = rt.store.create(input); rt.scheduler.refresh(); return r } } : null
    },
    worktreeRoot: worktreeRoot(),
    makeWorktree: ({ repo, title, branch }) => createWorkspaceWorktree({ repo, title, ...(branch ? { branch } : {}), runSetup: false }),
    isNodeToken: isValidNodeToken,
    newId: () => crypto.randomUUID(),
    now: Date.now,
  }
}
