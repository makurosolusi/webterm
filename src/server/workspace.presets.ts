import { isAgentChatPreset } from '../shared/agentChat.shape'
import type { WsNode } from '../shared/workspace.shape'
import { MAX_SKILL_NAME, SKILL_NAME_RE } from './central/skills/skillLint'

/**
 * `preset` / `presetTarget` decide the server-side tool lock and role prompt of an agent chat node, but the
 * workspace write path is client-controlled. So they are fixed at birth: an existing node keeps its STORED values
 * whatever the writer sent (a stale client that lost the field must not turn a locked chat into a plain one), and a
 * new node may only be born with a known preset and a well-formed skill target; anything else is dropped (the save
 * itself still succeeds).
 */
export function lockNodePresets(incoming: readonly WsNode[], stored: readonly WsNode[]): WsNode[] {
  const byId = new Map(stored.map((n) => [n.id, n]))
  return incoming.map((n) => {
    const { preset: _p, presetTarget: _t, ...rest } = n
    const old = byId.get(n.id)
    const preset = old ? old.preset : isAgentChatPreset(n.preset) ? n.preset : undefined
    const t = old ? old.presetTarget : n.presetTarget
    const target = preset && typeof t === 'string' && t.length <= MAX_SKILL_NAME && SKILL_NAME_RE.test(t) ? t : undefined
    return { ...rest, ...(preset ? { preset } : {}), ...(target ? { presetTarget: target } : {}) }
  })
}
