// Bound-chat slash commands (/status, /inbox, /approve, /reject, ...) -> reply text. Only reached
// after channelDispatch.ts has authorized the command; approval checks stay in the ledger.
import type { ChannelBinding, ChannelCommand } from './identity'
import { handleApprove, handleReject, type ApprovalDeps, type ApprovalSummary } from './channelApprovals'
import type { NormalizedMessage } from './telegram'

async function renderApprovals(
  deps: ApprovalDeps,
  projectId: string,
  heading: string
): Promise<string> {
  if (!deps.approval) return 'Approvals are unavailable: the ledger runtime is off.'
  let rows: ApprovalSummary[]
  try {
    rows = deps.approval.listApprovals({ projectId, status: 'pending', limit: 5 })
  } catch {
    return 'Could not read approvals. Nothing changed.'
  }
  if (rows.length === 0) return `${heading}: no pending approvals for project ${projectId}.`
  const lines = rows.map((row) => `- ${row.id} ${row.kind ?? 'approval'} exp=${row.expiresAt ?? 'n/a'}`)
  return [`${heading}: ${rows.length} pending approval(s) in project ${projectId}.`, ...lines].join('\n')
}

/** Runs an authorized command and returns the text to send back. */
export async function runCommand(
  deps: ApprovalDeps,
  message: NormalizedMessage,
  binding: ChannelBinding,
  command: ChannelCommand
): Promise<string> {
  switch (command.kind) {
    case 'status':
      return renderApprovals(deps, binding.projectId, 'Status')
    case 'inbox':
      return renderApprovals(deps, binding.projectId, 'Inbox')
    case 'approve':
      return handleApprove(deps, message, binding, command)
    case 'reject':
      return handleReject(deps, message, binding, command)
    case 'pause':
    case 'resume':
      return 'Pause and resume are controlled from the webterm UI in v1; this channel does not change project state.'
    case 'task':
      return 'Task detail is not available on this channel in v1. Use /inbox or the webterm UI.'
  }
}
