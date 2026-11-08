// Authorization + route entry for the context-link backend: resolves the requester's link
// doc from its own workspace and renders the requested verb.
import type { Workspace } from '../shared/workspace'
import { BROWSER_KIND } from '../shared/browser.contract'
import { AGENT_CHAT_KIND } from '../shared/agentChat.shape'
import {
  type ContextLinkVerb,
  type LinkDoc,
  type LinkDocEntry,
  parseSummaryCount,
  pickLinkNode,
  renderFullTranscript,
  renderList,
  renderSummary,
  renderTerminal,
  stripAnsi,
} from './contextLinkRender'
import { readTranscriptFile, renderTranscriptLines } from './contextLinkTranscript'

// --- authorization: resolve the requester's link doc from its own workspace ---

/** Ids of the nodes wired to `requesterId` by a canvas edge (either direction). Shared with browser-agent targeting. */
export function linkedPeerIds(ws: Workspace, requesterId: string): Set<string> {
  const peerIds = new Set<string>()
  for (const b of ws.bridges) {
    if (b.source === requesterId) peerIds.add(b.target)
    else if (b.target === requesterId) peerIds.add(b.source)
  }
  return peerIds
}

export function buildLinkDoc(ws: Workspace, requesterId: string): LinkDoc {
  const links: LinkDocEntry[] = []
  for (const id of linkedPeerIds(ws, requesterId)) {
    const n = ws.nodes.find((x) => x.id === id)
    // Browser yang dikabel = target kemudi (`resolveLinkedBrowser`), bukan peer transcript/terminal.
    if (n && n.kind !== BROWSER_KIND) links.push({ id: n.id, name: n.name, title: n.title || n.id, agent: n.agentId, sessionId: n.kind === AGENT_CHAT_KIND ? n.chatSessionId : n.sessionId })
  }
  return { links }
}

export function findWorkspaceFor(list: Workspace[], requesterId: string): Workspace | undefined {
  return list.find((ws) => ws.nodes.some((n) => n.id === requesterId))
}

// --- route entry (not pure — reads db, fs, sessions) ---

export async function renderForRequester(
  requesterId: string, verb: ContextLinkVerb, args: { node?: string; n?: string }
): Promise<string> {
  // Loaded lazily: ./db pulls bun:sqlite, which the node-env vitest suite (pure
  // helpers only) must never import at module top level.
  const { db } = await import('./db')
  const { sessions } = await import('./sessions')
  const ws = findWorkspaceFor(db.list(), requesterId)
  if (!ws) return 'Not a webterm agent node — nothing to read.'
  const doc = buildLinkDoc(ws, requesterId)
  if (verb === 'list') return renderList(doc)
  const picked = pickLinkNode(doc, args.node)
  if ('message' in picked) return picked.message
  const node = picked.node
  if (verb === 'terminal') return renderTerminal(node, stripAnsi(sessions.getTerminal(node.id)))
  // summary | transcript — claude jsonl transcript fed by the hook
  const path = sessions.getTranscript(node.id)
  const buf = path ? readTranscriptFile(path) : null
  if (buf == null) return `"${node.title}" has no conversation transcript yet.`
  const lines = renderTranscriptLines(buf)
  return verb === 'summary' ? renderSummary(node, lines, parseSummaryCount(args.n)) : renderFullTranscript(node, lines)
}
