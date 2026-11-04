// Source Control capabilities (plan I2-a): every SCM verb declares its tier up front (Orca
// rpc-method-permission). The routes are human-UI only (`uiOnlyDenial` in gitScm.route.ts), so an agent
// that is allowed one by policy still gets 403 from the route; push and PR are R3 + destructive, so
// policy never auto-allows them for a non-human rule either.
import { defineCapability, type CapabilitySpec } from './capability/capability.define'
import { obj, S } from './capability/capability.schema'
import { SCM_COMMIT_PATH, SCM_PR_PATH, SCM_PUSH_PATH, SCM_STAGE_PATH, SCM_STATUS_PATH, SCM_UNSTAGE_PATH } from './gitScm.types'

const root = { root: S.str(4096) }
const file = obj({ ...root, path: S.str(4096), hunkId: S.str(64) }, ['root', 'path'])

export const SCM_CAPABILITIES: readonly CapabilitySpec[] = [
  defineCapability({
    name: 'git.scm.status', summary: 'Read source control status of a repo: staged, unstaged and untracked files, branch and upstream.',
    tier: 'R0', scope: 'project', projections: ['control-http'], idempotent: true, route: { method: 'GET', path: SCM_STATUS_PATH },
    input: obj(root, ['root']), output: S.anyObj('ScmStatus (gitScm.types.ts).'),
  }),
  defineCapability({
    name: 'git.scm.stage', summary: 'Stage one changed file or hunk (secret-named files refused). Human UI only.',
    tier: 'R1', scope: 'project', projections: ['control-http'], idempotent: true, route: { method: 'POST', path: SCM_STAGE_PATH },
    input: file, output: S.keys('ok'),
  }),
  defineCapability({
    name: 'git.scm.unstage', summary: 'Unstage one staged file or hunk. Human UI only.',
    tier: 'R1', scope: 'project', projections: ['control-http'], idempotent: true, route: { method: 'POST', path: SCM_UNSTAGE_PATH },
    input: file, output: S.keys('ok'),
  }),
  defineCapability({
    name: 'git.scm.commit', summary: 'Commit the staged changes with a <type>(<scope>): <description> message. Human UI only.',
    tier: 'R2', scope: 'project', projections: ['control-http'], route: { method: 'POST', path: SCM_COMMIT_PATH },
    input: obj({ ...root, message: S.str(10_000) }, ['root', 'message']), output: S.keys('ok', 'head'),
  }),
  defineCapability({
    name: 'git.scm.push', summary: 'Push the branch to origin after a green pre-push report. Human UI only, never forced.',
    tier: 'R3', scope: 'project', projections: ['control-http'], destructive: true, route: { method: 'POST', path: SCM_PUSH_PATH },
    input: obj({ ...root, acknowledge: S.bool() }, ['root']), output: S.keys('ok', 'output'),
  }),
  defineCapability({
    name: 'git.scm.pr', summary: 'Open a pull request for the pushed branch with gh pr create. Human UI only.',
    tier: 'R3', scope: 'project', projections: ['control-http'], destructive: true, route: { method: 'POST', path: SCM_PR_PATH },
    input: obj(root, ['root']), output: S.keys('ok', 'url'),
  }),
]
