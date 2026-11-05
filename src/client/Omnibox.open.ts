// Omnibox state + what a chosen row does (focus node, run command, spawn agent, open URL in a
// browser node, open file in an editor node at a line). App only wires board actions in.
import { useCallback, useMemo, useState, type MutableRefObject } from 'react'
import type { Node, XYPosition } from '@xyflow/react'
import { nodeTargets } from './paletteTargets'
import { EDITOR_SIZE, openEditorFor } from './fileOpen'
import { PLAN_SIZE } from './PlanNode.model'
import { loadMonaco } from './lazyMonaco'
import { randomId } from './randomId'
import { loadRecent } from './browser.recent'
import { recordRecentFile } from './QuickOpen.recency'
import { listCommands, chordLabel, effectiveKey, useCommands } from './commandRegistry'
import { useKeybindingOverrides } from './keybindings.store'
import { isMacPlatform } from './terminalKeys'
import type { OmniAction, OmniScope, OmniSources } from './Omnibox.sources'
import type { OpenBrowserReq, OpenResult } from './browser.open.plan'
import { resolveOmniboxInput, looksLikeSearchQuery } from '../shared/browser.omnibox'
import { BUILTIN_AGENT_IDS, agentConfig, assembleCmd, customLaunchCmd, isBuiltinAgent, type AgentId, type Workspace, type WsNode } from '../shared/workspace'
import type { Settings } from '../shared/settings'
import type { PaletteCommand } from './output/outputCommands'

/** How long a just-opened editor gets to mount before the line reveal gives up. */
const REVEAL_TRIES = 50
const REVEAL_EVERY_MS = 100

/**
 * Move the editor showing `absPath` to `line`. ponytail: polls Monaco's editor list instead of an
 * EditorNode `line` prop (that file is outside this change); swap for the prop when it exists.
 */
export async function revealFileLine(absPath: string, line: number, col = 1): Promise<boolean> {
  const m = await loadMonaco()
  const want = m.Uri.file(absPath).path
  for (let i = 0; i < REVEAL_TRIES; i++) {
    // Node models carry `#nodeId`; a peek widget's embedded editor (no fragment) is not the node.
    const ed = m.editor.getEditors().find((e) => e.getModel()?.uri.path === want && !!e.getModel()?.uri.fragment)
    if (ed) {
      ed.setPosition({ lineNumber: line, column: col })
      ed.revealLineInCenter(line)
      ed.focus()
      return true
    }
    await new Promise((r) => setTimeout(r, REVEAL_EVERY_MS))
  }
  return false
}

export interface OpenEditorDeps {
  nodesRef: MutableRefObject<Node[]>
  addFlowNode: OmniboxDeps['addFlowNode']
  onFocus: (id: string) => void
}

/** Focus the editor node holding `absPath` (or add one) and move it to `line`. */
export function openEditorAt(d: OpenEditorDeps, absPath: string, line?: number, col?: number): void {
  const existing = openEditorFor(d.nodesRef.current, absPath)
  const id = existing ?? randomId()
  if (!existing) d.addFlowNode(() => ({ id, kind: 'editor', filePath: absPath, title: absPath.slice(absPath.lastIndexOf('/') + 1), ...EDITOR_SIZE }))
  setTimeout(() => d.onFocus(id), 0) // after the new node has rendered
  if (line) void revealFileLine(absPath, line, col).catch((e: unknown) => console.warn('open editor: reveal line failed', e instanceof Error ? e.message : String(e)))
}

/** Typed text → URL only when it reads as an address; a phrase stays a palette query. */
export function addressUrl(q: string): string | null {
  if (looksLikeSearchQuery(q)) return null
  const r = resolveOmniboxInput(q)
  return r?.ok ? r.url : null
}

const joinPath = (root: string, rel: string): string => `${root.replace(/\/+$/, '')}/${rel}`

export interface OmniboxDeps {
  root?: string
  nodes: Node[]
  nodesRef: MutableRefObject<Node[]>
  settings: Settings
  extraCommands?: PaletteCommand[]
  addFlowNode: (make: (n: number, ws: Workspace) => Omit<WsNode, 'x' | 'y'>, at?: XYPosition) => void
  onFocus: (id: string) => void
  onAddAgent: (cmd: string, agentId: AgentId) => void
  openBrowserAt?: (req: OpenBrowserReq) => OpenResult
}

export function useOmnibox(d: OmniboxDeps) {
  const [state, setState] = useState<{ scope: OmniScope; initialQuery: string } | null>(null)
  const open = useCallback((scope: OmniScope, initialQuery = '') => setState({ scope, initialQuery }), [])
  const close = useCallback(() => setState(null), [])
  const commands = useCommands()
  const overrides = useKeybindingOverrides()
  const { disabledAgents, customAgents, agentLaunchCommands } = d.settings

  const agents = useMemo(() => [
    ...BUILTIN_AGENT_IDS.filter((a) => !disabledAgents.includes(a)).map((a) => ({ id: a as string, label: agentConfig(a)?.label ?? a })),
    ...customAgents.filter((c) => !disabledAgents.includes(c.id)).map((c) => ({ id: c.id as string, label: c.label })),
  ], [disabledAgents, customAgents])

  const sources = useMemo<Omit<OmniSources, 'files' | 'recentFiles'>>(() => {
    const isMac = isMacPlatform()
    const palette = commands.filter((c) => c.run && !c.hidden).map((c) => {
      const key = effectiveKey(c, overrides)
      return { id: c.id, label: c.label, keybinding: key ? chordLabel(key, isMac) : undefined }
    })
    return {
      nodes: nodeTargets(d.nodes), agents, recentUrls: d.openBrowserAt ? loadRecent() : [], asUrl: d.openBrowserAt ? addressUrl : () => null,
      commands: [...palette, ...(d.extraCommands ?? []).map(({ id, label, keybinding }) => ({ id, label, keybinding }))],
    }
    // `state` re-reads recent URLs on every open.
  }, [commands, overrides, d.nodes, d.extraCommands, d.openBrowserAt, agents, state])

  const openFile = useCallback((rel: string, line?: number, col?: number) => {
    if (!d.root) return
    const abs = joinPath(d.root, rel)
    recordRecentFile(abs)
    openEditorAt(d, abs, line, col)
  }, [d])

  const onAction = useCallback((a: OmniAction) => {
    if (a.kind === 'node') d.onFocus(a.id)
    else if (a.kind === 'command') (listCommands().find((c) => c.id === a.id)?.run ?? d.extraCommands?.find((c) => c.id === a.id)?.run)?.()
    else if (a.kind === 'url') d.openBrowserAt?.({ url: a.url })
    // A Plan node drafts on mount (PlanNode); approval is a separate human click on the node.
    else if (a.kind === 'plan') d.addFlowNode((_, ws) => ({ id: randomId(), kind: 'plan', title: 'Plan', ...PLAN_SIZE, plan: { intent: a.intent, workspaceId: ws.id } }))
    else if (a.kind === 'file') openFile(a.rel, a.line, a.col)
    else if (a.kind === 'agent') {
      const id = a.id as AgentId
      const custom = customAgents.find((c) => c.id === id)
      if (custom) d.onAddAgent(customLaunchCmd(custom, agentLaunchCommands), id)
      else if (isBuiltinAgent(id)) d.onAddAgent(assembleCmd(id, agentLaunchCommands[id]), id)
    }
  }, [d, openFile, customAgents, agentLaunchCommands])

  return { open, close, state, sources, onAction }
}
