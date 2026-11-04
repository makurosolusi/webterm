// Git read capabilities declared in the registry (plan I1-b: `git.diff` at R0). The handler is the
// plain `/api/git/diff` route (gitDiff.route.ts), bound through `route` like the control verbs.
import { GIT_DIFF_PAGE_MAX, GIT_DIFF_PATH } from '../gitDiff.types'
import { defineCapability, type CapabilitySpec } from './capability.define'
import { obj, S } from './capability.schema'

export const GIT_CAPABILITIES: readonly CapabilitySpec[] = [
  defineCapability({
    name: 'git.diff', summary: 'Read the working-tree diff of a repo against HEAD: changed files (paged) or one file with hunks.',
    tier: 'R0', scope: 'project', projections: ['control-http'], idempotent: true, route: { method: 'GET', path: GIT_DIFF_PATH },
    input: obj({ root: S.str(4096), path: S.str(4096), offset: S.int(0), limit: S.int(1, GIT_DIFF_PAGE_MAX) }, ['root']),
    output: S.anyObj('GitDiffList, or GitFileDiff when path is given (gitDiff.types.ts).'),
  }),
]
