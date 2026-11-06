/** @vitest-environment jsdom */
// Every node kind must reach every registry that is NOT typed exhaustively (a plain array or
// conditional list compiles fine when a new kind is forgotten). `Record<WsNodeKind, …>` registries are
// already enforced by tsc. Kinds a registry leaves out on purpose are listed in its allowlist.
// Server-side registries (templates, awareness card): src/server/nodeKinds.server.test.ts.
import { describe, expect, it } from 'vitest'
import type { Workspace, WsNodeKind } from '../shared/workspace'
import { NODE_KIND_LABEL } from './nodeList'
import { SESSION_KINDS } from './sessionList'
import { buildCanvasMenuRows } from './canvasMenu.model'
import { newTabMenuItems } from './tabLayout.newMenu'
import { omniboxItems, type OmniSources } from './Omnibox.sources'
import { nodeTypes } from './nodeTypes'
import { canLink } from './floatingEdge'
import { AGENT_CHAT_COMMAND_ID, newAgentChatNode } from './agentChat.add'

const ALL = Object.keys(NODE_KIND_LABEL) as WsNodeKind[]
const noop = () => undefined
/** Kinds absent from `list`, minus the allowlist: must be empty. */
const missing = (list: readonly string[], allow: readonly WsNodeKind[]) => ALL.filter((k) => !list.includes(k) && !allow.includes(k))

// Placed by something else, never by a "new node" entry: an editor by opening a file, a plan by
// typing an intent (⌘K), an app by an agent's MCP view.
const NOT_HAND_CREATED: readonly WsNodeKind[] = ['editor', 'plan', 'app']

describe('node kind registries cover every WsNodeKind', () => {
  it('SESSION_KINDS lists every kind that owns a live agent/shell session', () => {
    expect(missing(SESSION_KINDS, ['files', 'editor', 'browser', 'diff', 'plan', 'app'])).toEqual([])
  })

  it('the canvas context menu can create every hand-created kind', () => {
    const rows = buildCanvasMenuRows(
      { addTerminal: noop, addAgent: noop, addFiles: noop, addBrowser: noop, addDiff: noop, addAgentChat: noop, fitView: noop },
      { nodeCount: 0, disabledAgents: [], customAgents: [], agentLaunchCommands: {} },
    )
    const keys = rows.map((r) => ('key' in r ? r.key : '')).map((k) => (k.startsWith('agent:') ? 'agent' : k))
    expect(missing(keys, NOT_HAND_CREATED)).toEqual([])
  })

  it('the tab-mode "+" menu can create every hand-created kind', () => {
    const ids = newTabMenuItems({ onAddTerminal: noop, onAddAgent: noop, onAddAgentChat: noop, onAddBrowser: noop, onAddDiff: noop, onAddFiles: noop })
      .map((i) => ('id' in i ? i.id : ''))
    expect(missing(ids, NOT_HAND_CREATED)).toEqual([])
  })

  it('⌘K can create agents, agent chats, browsers and plans', () => {
    const src: OmniSources = {
      nodes: [], commands: [{ id: AGENT_CHAT_COMMAND_ID, label: 'Agent Chat: New Agent Chat' }], agents: [{ id: 'claude', label: 'Claude' }],
      recentUrls: [], files: [], recentFiles: [], asUrl: (q) => (q.includes('.') ? `https://${q}` : null),
    }
    const ids = [...omniboxItems('', 'all', src), ...omniboxItems('example.com', 'all', src), ...omniboxItems('add a login form', 'all', src)].map((i) => i.id)
    expect(ids).toEqual(expect.arrayContaining(['agent:claude', `command:${AGENT_CHAT_COMMAND_ID}`, 'url:typed', 'plan:typed']))
  })

  it('nodeTypes renders every kind', () => {
    expect(missing(Object.keys(nodeTypes), [])).toEqual([])
  })
})

describe('agentChat node', () => {
  const ws = { id: 'w', name: 'B', cwd: '/proj', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], bridges: [] } as unknown as Workspace

  it('is born with the default Claude profile and no chat session', () => {
    const n = newAgentChatNode(ws, 'prof-1')
    expect(n).toMatchObject({ kind: 'agentChat', agentId: 'claude', cwd: '/proj', claudeProfileId: 'prof-1' })
    expect(n.chatSessionId).toBeUndefined()
  })

  it('cables to agents and browsers like an agent node', () => {
    const chat = { id: 'c', kind: 'agentChat', agentId: 'claude' } as const
    expect(canLink(chat, { id: 'a', kind: 'agent', agentId: 'claude' })).toBe(true)
    expect(canLink(chat, { id: 'b', kind: 'browser' })).toBe(true)
  })
})
