// Which Central tools need a human OK once the conversation read untrusted web content (see taintStore.ts).
// R0 is safe by default; R1+ is IMPACTFUL by default unless named in SAFE_UNDER_TAINT. The classification test
// requires every registered R1+ tool to be named in exactly one list, so a new tool cannot slip through unclassified.
import type { Tier } from '../contracts/level.types'
import { noteTaintedAsk, originOf, taintedOrigins } from './taintStore'

/** Effects on nodes, tasks, memory, schedule, channels, permissions or the web: data from the page could be steering them. */
export const IMPACTFUL_TOOLS: readonly string[] = [
  'agent.spawn', 'agent.prompt', 'agent.relay', 'agent.close',
  'canvas.open', 'canvas.reopen', 'canvas.close', 'canvas.type', 'canvas.edit',
  'chat.send', 'chat.config', 'chat.mode', 'channel.bot.propose',
  'task.assign', 'task.create', 'task.update', 'task.cancel', 'permission.decide',
  'memory.remember', 'memory.update', 'memory.forget', 'memory.remember_user', 'state.update', 'reminder.set', 'reminder.cancel',
  'workspace.create', 'workspace.rename',
  'playbook.code_change', 'playbook.review', 'playbook.web_research',
  'browser_open', 'browser_act', 'browser_read',
]

/** Above R0 but harmless under taint: they only propose (a human still decides), start a read-only scan, or move the view. */
export const SAFE_UNDER_TAINT: readonly string[] = [
  'approval.request', 'blackboard.propose', 'goal.propose', 'plan.propose', 'skill.propose',
  'health.scan', 'health.analyze', 'canvas.show', 'canvas.group', 'canvas.camera', 'workspace.switch', 'workspace.color',
]

/** Browser tools whose url is an exfiltration channel (data can ride in the query): allowed only to an origin already read. */
const NAVIGATING: readonly string[] = ['browser_read', 'browser_act']

/** True when `tool` is impactful under taint (a named IMPACTFUL tool; an unnamed one above R0 counts too). */
export function isImpactful(tool: string, tier: Tier): boolean {
  if (IMPACTFUL_TOOLS.includes(tool)) return true
  return !SAFE_UNDER_TAINT.includes(tool) && tier !== 'R0'
}

export interface TaintCheck { conversationId?: string | undefined; tool: string; tier: Tier; url?: string | undefined }

/** True when this Central call must ask a human because its conversation is tainted; records why for the card. */
export function taintNeedsApproval(req: TaintCheck, now: number): boolean {
  if (!req.conversationId) return false
  const origins = taintedOrigins(req.conversationId, now)
  if (!origins || !isImpactful(req.tool, req.tier)) return false
  if (NAVIGATING.includes(req.tool) && req.url !== undefined) {
    const origin = originOf(req.url)
    if (origin && origins.has(origin)) return false
  }
  noteTaintedAsk(req.conversationId, req.tool, now)
  return true
}
