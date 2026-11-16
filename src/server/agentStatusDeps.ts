// Dependencies of the `POST /api/agent-status` route: the injectable write side, its production
// wiring and the pre-prompt checkpoint. Split from `agentStatusApi.ts` to keep the route small.
import type { AgentStatus, Workspace } from '../shared/workspace'
import type { StatusReason } from '../shared/protocol'
import { findWorkspaceFor } from './contextLink'
import { startLinkNotes } from './linkNoteDelivery'
import { takeCheckpointSafe } from './checkpoint/checkpoint.service'
import { activeBrowser } from './browser/browser.state'
import type { PermissionOutput } from './permission/permission.model'
import type { PermissionAsk } from './permission/permission.wait'
import type { PreToolAsk } from './permission/permission.preTool'
import type { ApprovalModeName } from '../shared/settings.projectApprovalLevels'

/** Sisi tulis route, di-inject supaya route bisa diuji tanpa `bun:sqlite`/PTY. */
export interface AgentStatusDeps {
  /** `reason` = why it needs you or failed (tool name, notification line), when the hook said. */
  setStatus(nodeId: string, status: AgentStatus, reason?: StatusReason): void
  setTranscript(nodeId: string, path: string): void
  workspaceFor(nodeId: string): Workspace | null | undefined
  /** Gives a browser node's lease back to the human; absent = browser runtime not wired (tests). */
  releaseBrowser?(browserNodeId: string): void
  /** Holds a `PermissionRequest` for a human decision (F3-b); absent = no decision, Claude prompts. */
  answerPermission?(ask: PermissionAsk): Promise<PermissionOutput | null>
  /** PreToolUse: deny by a user Deny rule in every mode (permission.preTool.ts); absent = not wired (tests). */
  preToolRule?(ask: PreToolAsk): Record<string, unknown>
  /** Ask/Auto/Danger the node runs under (launch level, else its workspace's level); absent = not recorded. */
  modeOf?(nodeId: string, workspaceId: string | null): ApprovalModeName
}

/** Opsi test: override gerbang + dependency. Produksi memanggil route tanpa argumen keempat. */
export interface AgentStatusOptions {
  strictAuth?: boolean
  deps?: AgentStatusDeps
}

/**
 * Dependency default. Diimpor DINAMIS: `db`/`sessions` menarik `bun:sqlite` dan PTY, jadi impor
 * statis akan membuat modul route ini tidak bisa dimuat test node-env (yang menguji gerbang auth
 * dengan dependency palsu).
 */
export async function defaultDeps(): Promise<AgentStatusDeps> {
  const [{ db }, { sessions }, { answerPermissionLive, preToolRuleLive }, { sessionModeName }] = await Promise.all([import('./db'), import('./sessions'), import('./permission/permission.runtime'), import('./permission/permission.mode')])
  // Satu-satunya titik start loop link-note: hook Claude Code pertama (SessionStart) menyalakannya,
  // jadi tidak ada flag/konfigurasi — dan test dengan deps palsu tidak pernah memuatnya.
  await startLinkNotes()
  return {
    setStatus: (nodeId, status, reason) => sessions.setStatus(nodeId, status, undefined, reason),
    setTranscript: (nodeId, path) => sessions.setTranscript(nodeId, path),
    workspaceFor: (nodeId) => findWorkspaceFor(db.list(), nodeId),
    releaseBrowser: (id) => activeBrowser()?.releaseLease(id),
    // Read per request: the Settings toggle applies to the very next prompt, no restart.
    answerPermission: (ask) => {
      const s = db.getSettings()
      return answerPermissionLive(ask, s.hookReplyApprovals !== false, { routing: s.permissionRouting, checkins: s.centralCheckins })
    },
    preToolRule: preToolRuleLive,
    modeOf: (nodeId, workspaceId) => sessionModeName(db.getSettings(), nodeId, workspaceId),
  }
}

/**
 * F3-c: a new prompt is about to make the agent act, so its workspace is snapshotted first. Kept
 * above the route on purpose: the route body must not carry its own event list (hooks.test.ts).
 * `takeCheckpointSafe` never throws, so a broken checkpoint cannot fail the hook reply.
 */
export async function checkpointBeforePrompt(event: string | undefined, ws: Workspace | null | undefined, nodeId: string): Promise<void> {
  if (event === 'UserPromptSubmit' && ws) await takeCheckpointSafe(ws, { reason: 'prompt', nodeId })
}

