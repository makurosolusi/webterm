// Central's pinned STATE tools. Scope comes from the conversation: a project chat only ever reaches its own
// project; the global chat reaches global STATE, or one project with an explicit projectId.
import { obj, S } from '../../../capability/capability.schema'
import { getRow } from '../../../ledger/ledgerCore'
import { scopeFromConversationId } from '../../conversationModel'
import { CentralStateError, GLOBAL_STATE, STATE_MAX_BYTES, STATE_MAX_LINES, projectState, readState, writeState } from '../../context/centralState'
import type { ToolCtx, ToolDef, ToolInput, ToolResult, ToolValidationCode } from '../toolTypes'
import { MAX_ID, isSafeId } from './read.shared'

const STATE_ACTOR = 'central'
const VERSION_MAX = Number.MAX_SAFE_INTEGER

function scopeOf(ctx: ToolCtx, input: ToolInput): string {
  const conversation = scopeFromConversationId(ctx.conversationId)
  if (conversation.kind === 'project') return projectState(conversation.projectId)
  return typeof input.projectId === 'string' ? projectState(input.projectId) : GLOBAL_STATE
}

function checkProject(input: ToolInput, ctx: ToolCtx): ToolValidationCode | null {
  if (input.projectId === undefined) return null
  if (!isSafeId(input.projectId)) return 'invalid_shape'
  const conversation = scopeFromConversationId(ctx.conversationId)
  if (conversation.kind === 'project' && conversation.projectId !== input.projectId) return 'conversation_project_mismatch'
  return getRow(ctx.db, 'SELECT 1 AS one FROM project WHERE id = ?', input.projectId) === null ? 'project_not_found' : null
}

const read: ToolDef = {
  name: 'state.read', summary: 'Read the pinned STATE document of this conversation, with its version.', tier: 'R0',
  projectScoped: false, auditKeys: ['scope', 'version'],
  usage: '{"projectId":"optional; global chat only, omit for global STATE"}. Version 0 means nothing was written yet.',
  input: obj({ projectId: S.str(MAX_ID) }, []),
  output: S.keys('scope', 'version', 'body', 'updatedAt', 'updatedBy'),
  validate: checkProject,
  handler(ctx, input): ToolResult {
    const scope = scopeOf(ctx, input)
    const doc = readState(ctx.db, scope)
    return { ok: true, data: { scope, version: doc?.version ?? 0, body: doc?.body ?? '', updatedAt: doc?.updatedAt ?? null, updatedBy: doc?.updatedBy ?? null } }
  },
}

const update: ToolDef = {
  name: 'state.update', summary: 'Replace the pinned STATE document: what is in flight, decisions, next steps.', tier: 'R1',
  projectScoped: false, auditKeys: ['scope', 'version'],
  usage: `{"projectId":"optional; global chat only, omit for global STATE","body":"whole new document, at most ${STATE_MAX_LINES} lines and ${STATE_MAX_BYTES} bytes, no secrets","expectedVersion":<version from state.read, 0 if none>}. On version_conflict read again and merge.`,
  input: obj({ projectId: S.str(MAX_ID), body: S.str(), expectedVersion: S.int(0, VERSION_MAX) }, ['body', 'expectedVersion']),
  output: S.keys('scope', 'version'),
  validate: checkProject,
  handler(ctx, input): ToolResult {
    const scope = scopeOf(ctx, input)
    try {
      const doc = writeState(ctx.db, { scope, body: input.body as string, expectedVersion: input.expectedVersion as number, actor: STATE_ACTOR, now: ctx.now() })
      return { ok: true, data: { scope: doc.scope, version: doc.version } }
    } catch (err) {
      if (err instanceof CentralStateError) return { ok: false, code: err.code, data: { detail: err.message } }
      throw err
    }
  },
}

/** The pinned STATE tools. */
export const STATE_DEFS: readonly ToolDef[] = [read, update]
