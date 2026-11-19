import { useCallback, useEffect, useMemo, useState } from 'react'
import { openProfileSpawn } from './browserProfile.spawn'
import { PROFILE_TEXT } from './browserProfile.text'
import { BUILTIN_AGENT_IDS, agentConfig, assembleCmd, customLaunchCmd } from '../shared/workspace'
import type { BuiltinAgentId } from '../shared/workspace'
import { DEFAULT_SETTINGS } from '../shared/settings'
import type { CustomAgent } from '../shared/settings'
import { VscodeActivityBar } from '@/components/vscode/vscodeActivityBar'
import type { VscodeActivityBarItem } from '@/components/vscode/vscodeActivityBar'
import { VscodeQuickPick } from '@/components/vscode/vscodeQuickPick'
import type { VscodeQuickPickItem } from '@/components/vscode/vscodeQuickPick'
import { IconButton } from '@/components/ui/icon-button'
import { codicon } from './dockCodicon'
import { useCommands } from './commandRegistry'
import { AGENT_CHAT_COMMAND_ID } from './agentChat.add'
import { chatApi } from './chatApi'
import { useChatFeed } from './chat/chatFeed'
import { CanvasStatusBar } from './Dock.statusBar'
import { useCapabilityOffer } from './Dock.capabilityOffer'
import { WorkspaceDialog } from './Dock.workspaceDialog'
import { DockModes } from './Dock.modes'
import { useRailLabelsAttribute } from './railLabels.store'
import './workspaceRail.css'

import type { DockProps } from './Dock.types'
import { useTabLayout } from './tabLayout.store'
import { SIDE_BAR_VIEW_COMMANDS } from './sideBar/sideBar.commands'
export type { DockProps } from './Dock.types'

export { ZOOM_PRESETS } from './Dock.statusBar'

/** Id baris Quick Pick "Add node"; agent builtin/custom diberi prefix + id agent. */
const ADD_TERMINAL_ID = 'terminal'
const ADD_BROWSER_ID = 'browser'
const ADD_BROWSER_PROFILE_ID = 'browser-profile'
const ADD_BROWSER_EACH_ID = 'browser-each'
const ADD_WORKSPACE_ID = 'workspace'
/** Id of the registered "new diff node" command (commandRegistry.defaults.ts); the Dock runs it. */
const DIFF_COMMAND_ID = 'diff.new'
/** Id of the registered "new Files node" command; the Dock runs it like Diff. */
const FILES_COMMAND_ID = 'files.new'
const ADD_BUILTIN_PREFIX = 'builtin:'
const ADD_CUSTOM_PREFIX = 'custom:'
const ADD_TRIGGER_SELECTOR = '[data-slot="vscode-activity-bar-item"][aria-label="Add node"]'

/** Ikon rail yang menyala: view side bar kiri yang tampil, Central (side bar terbuka, tab apa pun), dan Board. */
function activeActivityIds(props: DockProps): string[] {
  return [
    ...(props.sideBarOpen ? [props.sideBarView] : []),
    ...(props.chatOpen ? ['chat'] : []),
    ...(props.boardOpen ? ['board'] : []),
  ]
}

/**
 * Chrome kiri + bawah aplikasi.
 *
 * Activity bar 48px memuat permukaan (Layers, Sessions, Agent History, Central, Board) dan aksi Add; lock/clean view
 * adalah toggle mode sehingga dirender sendiri dengan `aria-pressed`. Status bar 22px memuat
 * aksi kanvas (`Dock.statusBar.tsx`). Quick Pick Add tetap di sini karena tombol pembukanya ada di rail.
 */
export default function Dock(props: DockProps) {
  useRailLabelsAttribute()
  const [workspaceOpen, setWorkspaceOpen] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const canvasMode = useTabLayout().mode !== 'tabs'
  const { onAddBrowser } = props
  const { setOffer, dialog: offerDialog } = useCapabilityOffer(onAddBrowser)
  const disabled = props.disabledAgents ?? DEFAULT_SETTINGS.disabledAgents
  const customs = props.customAgents ?? DEFAULT_SETTINGS.customAgents
  const launchCmds = props.agentLaunchCommands ?? DEFAULT_SETTINGS.agentLaunchCommands
  // Memo pada identitas props: Quick Pick mengembalikan baris aktif ke atas tiap `items` baru,
  // jadi daftar tidak boleh berganti identitas pada setiap render induk (mis. tik zoom).
  const builtins = useMemo(() => BUILTIN_AGENT_IDS.filter((a) => !disabled.includes(a)), [disabled])
  const visibleCustoms = useMemo(() => customs.filter((c) => !disabled.includes(c.id)), [customs, disabled])

  useEffect(() => {
    if (!addOpen && !workspaceOpen) return

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setAddOpen(false)
      setWorkspaceOpen(false)
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [addOpen, workspaceOpen])

  const addBuiltin = (id: BuiltinAgentId) => {
    // cwd dibiarkan undefined: server memakai cwd workspace, sama seperti perilaku project yang
    // menambah agent dengan satu klik tanpa form.
    props.onAddAgent(assembleCmd(id, launchCmds[id]), id)
    setAddOpen(false)
  }

  const addTerminal = () => {
    props.onAddTerminal()
    setAddOpen(false)
  }

  const addCustom = (agent: CustomAgent) => {
    props.onAddAgent(customLaunchCmd(agent, launchCmds), agent.id)
    setAddOpen(false)
  }

  const openWorkspaceForm = () => {
    setAddOpen(false)
    setWorkspaceOpen(true)
  }

  const closeAdd = useCallback(() => setAddOpen(false), [])

  // Satu daftar Quick Pick: id baris = kunci pemilihnya, jadi `onAddSelect` tak perlu menutup
  // di atas closure per-baris. Ikon seragam codicon; warna agent tidak dibawa (VS Code tidak mewarnai).
  // Diff runs the app command (only registered while the diff feature is on), so no extra Dock prop.
  const commands = useCommands()
  const diffCommand = commands.find((c) => c.id === DIFF_COMMAND_ID && c.run)
  const filesCommand = commands.find((c) => c.id === FILES_COMMAND_ID && c.run)
  const addItems = useMemo<VscodeQuickPickItem[]>(() => [
    { id: ADD_TERMINAL_ID, label: 'Terminal', icon: codicon('terminal') },
    { id: ADD_BROWSER_ID, label: 'Browser', icon: codicon('globe') },
    ...(onAddBrowser ? [
      { id: ADD_BROWSER_PROFILE_ID, label: PROFILE_TEXT.withProfile, icon: codicon('globe') },
      { id: ADD_BROWSER_EACH_ID, label: PROFILE_TEXT.forEach, icon: codicon('globe') },
    ] : []),
    ...(filesCommand ? [{ id: FILES_COMMAND_ID, label: 'Files', icon: codicon('files') }] : []),
    ...(diffCommand ? [{ id: DIFF_COMMAND_ID, label: 'Diff (working changes)', icon: codicon('diff') }] : []),
    ...(commands.some((c) => c.id === AGENT_CHAT_COMMAND_ID && c.run) ? [{ id: AGENT_CHAT_COMMAND_ID, label: 'Agent Chat', icon: codicon('comment-discussion') }] : []),
    ...builtins.map((a) => {
      const cfg = agentConfig(a)
      return { id: `${ADD_BUILTIN_PREFIX}${a}`, label: cfg?.label ?? a, icon: codicon('hubot') }
    }),
    ...visibleCustoms.map((c) => ({ id: `${ADD_CUSTOM_PREFIX}${c.id}`, label: c.label, icon: codicon('hubot') })),
    { id: ADD_WORKSPACE_ID, label: 'Workspace…', icon: codicon('new-folder') },
  ], [builtins, visibleCustoms, diffCommand, filesCommand, commands, onAddBrowser])

  const onAddSelect = (id: string) => {
    if (id === ADD_TERMINAL_ID) return addTerminal()
    if (id === ADD_BROWSER_ID) {
      if (onAddBrowser) onAddBrowser()
      else setOffer('browser')
      return setAddOpen(false)
    }
    if (id === ADD_BROWSER_PROFILE_ID || id === ADD_BROWSER_EACH_ID) {
      openProfileSpawn(id === ADD_BROWSER_EACH_ID ? 'each' : 'one')
      return setAddOpen(false)
    }
    if (id === ADD_WORKSPACE_ID) return openWorkspaceForm()
    if (id === DIFF_COMMAND_ID || id === FILES_COMMAND_ID || id === AGENT_CHAT_COMMAND_ID) { commands.find((c) => c.id === id)?.run?.(); return setAddOpen(false) }
    if (id.startsWith(ADD_BUILTIN_PREFIX)) return addBuiltin(id.slice(ADD_BUILTIN_PREFIX.length) as BuiltinAgentId)
    const custom = visibleCustoms.find((c) => `${ADD_CUSTOM_PREFIX}${c.id}` === id)
    if (custom) addCustom(custom)
  }

  const waiting = props.needsYouCount ?? 0
  // Keeps the Central conversation list live while the side bar is closed; the badge is needs-you + unread chats.
  const chatUnread = useChatFeed(chatApi, props.onToggleChat !== undefined).unread.size
  const chatBadge = waiting + chatUnread
  const chatTip = [waiting > 0 && `${waiting} need${waiting === 1 ? 's' : ''} you`, chatUnread > 0 && `${chatUnread} unread`].filter(Boolean).join(', ')
  // One door to Central (like Copilot in VS Code): opens the side bar on Chat; its Control tab is one click
  // further. The tooltip shows ⌥⌘B through `commandId` (the side bar toggle), so a rebinding never drifts.
  const attention = props.sessionsAttention ?? 0
  const items: VscodeActivityBarItem[] = [
    { id: 'layers', label: 'Layers', icon: codicon('layers'), commandId: SIDE_BAR_VIEW_COMMANDS.layers.id },
    {
      id: 'sessions', label: 'Sessions', icon: codicon('list-tree'), commandId: SIDE_BAR_VIEW_COMMANDS.sessions.id,
      badge: attention, tooltip: attention > 0 ? `Sessions (${attention} need${attention === 1 ? 's' : ''} attention)` : undefined,
    },
    { id: 'history', label: 'Agent History', icon: codicon('history'), commandId: SIDE_BAR_VIEW_COMMANDS.history.id },
    { id: 'skills', label: 'Skills', icon: codicon('tools'), commandId: SIDE_BAR_VIEW_COMMANDS.skills.id },
    ...(props.onToggleChat
      ? [{
          id: 'chat', label: 'Central', icon: codicon('comment-discussion'), commandId: 'view.secondarySideBar',
          badge: chatBadge, tooltip: chatTip ? `Central (${chatTip})` : undefined,
        }]
      : []),
    { id: 'board', label: 'Board', tooltip: 'Toggle Kanban board', icon: codicon('project'), commandId: 'view.board' },
    { id: 'add', label: 'Add node', tooltip: 'Add node (terminal, browser, files, agent, workspace)', icon: codicon('add') },
  ]

  const onActivitySelect = (id: string) => {
    switch (id) {
      case 'layers':
      case 'sessions':
      case 'history':
      case 'skills':
        props.onSideBarView(id)
        break
      case 'chat':
        props.onToggleChat?.()
        break
      case 'board':
        props.onToggleBoard()
        break
      case 'add':
        setAddOpen((open) => !open)
        break
      default:
        break
    }
  }

  return (
    <>
      <div className="dock">
        {/* Compact/Hidden header: the app menu is the first control of the rail (Full keeps the menu bar). */}
        {props.railMenu}
        {/* Hidden header: search sits above the workspace group (Mod+K still works in every mode). */}
        {props.onOpenPalette && (
          <IconButton className="vscode-activity-bar__item dock-btn rounded-none" label="Search" tooltip="Go to anything: nodes, files, URLs, agents, commands"
            commandId="workbench.omnibox" side="right" onClick={props.onOpenPalette}>
            <span className="vscode-activity-bar__icon" aria-hidden>{codicon('search')}</span>
          </IconButton>
        )}
        {props.workspaceGroup}
        <VscodeActivityBar
          items={items}
          activeIds={activeActivityIds(props)}
          onSelect={onActivitySelect}
          ariaLabel="Activity bar"
        />

        <DockModes {...props} canvasMode={canvasMode} />

        <VscodeQuickPick
          open={addOpen}
          onClose={closeAdd}
          triggerSelector={ADD_TRIGGER_SELECTOR}
          ariaLabel="Add node"
          placeholder="Select a node type to add"
          emptyText="No matching node types"
          hint=""
          items={addItems}
          onSelect={onAddSelect}
        />

        {offerDialog}

        <WorkspaceDialog open={workspaceOpen} onOpenChange={setWorkspaceOpen}
          onCreateWorkspace={props.onCreateWorkspace} onBrowse={props.onBrowse} />
      </div>

      <CanvasStatusBar {...props} />
    </>
  )
}
