// Claude nodes made before launch profiles: the server launches them with the default profile
// (sessions.ts), and this records that profile on the node through the normal data-change save,
// so the node is stable afterwards. Waits for settings: before they load the default is unknown.
import { useEffect, type RefObject } from 'react'
import type { Node, ReactFlowInstance } from '@xyflow/react'
import type { Settings } from '../../shared/settings'
import { isLegacyClaudeNode, resolveClaudeProfileIn } from '../../shared/claudeLaunch/claudeLaunch.builtin'

/** Ids of board nodes that are legacy Claude nodes. */
export const legacyClaudeNodeIds = (nodes: readonly Node[]): string[] =>
  nodes.filter((n) => isLegacyClaudeNode(n.data as Parameters<typeof isLegacyClaudeNode>[0])).map((n) => n.id)

export function useRecordLegacyClaudeProfiles(
  nodes: readonly Node[],
  hydrated: boolean,
  settings: Settings,
  rf: RefObject<ReactFlowInstance | null>,
): void {
  useEffect(() => {
    if (!hydrated) return
    const ids = legacyClaudeNodeIds(nodes)
    if (!ids.length) return
    // Same id the server resolved (a stale default id resolves to Default, never recorded as missing).
    const claudeProfileId = resolveClaudeProfileIn(settings).profile.id
    for (const id of ids) rf.current?.updateNodeData(id, { claudeProfileId })
  }, [nodes, hydrated, settings, rf])
}
