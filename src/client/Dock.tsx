import { useCallback, useEffect, useMemo, useState } from 'react'
import { BUILTIN_AGENT_IDS, agentConfig, assembleCmd, customLaunchCmd } from '../shared/workspace'
import type { BuiltinAgentId } from '../shared/workspace'
import { DEFAULT_SETTINGS } from '../shared/settings'
import type { CustomAgent } from '../shared/settings'
import { VscodeActivityBar } from '@/components/vscode/vscodeActivityBar'
import type { VscodeActivityBarItem } from '@/components/vscode/vscodeActivityBar'
import { VscodeQuickPick } from '@/components/vscode/vscodeQuickPick'
import type { VscodeQuickPickItem } from '@/components/vscode/vscodeQuickPick'
import { codicon } from './dockCodicon'
import { CanvasStatusBar } from './Dock.statusBar'
import { useCapabilityOffer } from './Dock.capabilityOffer'
import { WorkspaceDialog } from './Dock.workspaceDialog'

import type { DockProps } from './Dock.types'
export type { DockProps } from './Dock.types'

export { ZOOM_PRESETS } from './Dock.statusBar'

/** Id baris Quick Pick "Add node"; agent builtin/custom diberi prefix + id agent. */
const ADD_TERMINAL_ID = 'terminal'
const ADD_BROWSER_ID = 'browser'
const ADD_WORKSPACE_ID = 'workspace'
const ADD_BUILTIN_PREFIX = 'builtin:'
const ADD_CUSTOM_PREFIX = 'custom:'
const ADD_TRIGGER_SELECTOR = '[data-slot="vscode-activity-bar-item"][aria-label="Add node"]'

/** Id aktivitas yang sedang "terpilih". Activity bar hanya punya satu slot aktif; permukaan
 *  webterm boleh terbuka bersamaan, jadi urutannya dipaku dan sisanya tampil non-aktif. */
function activeActivityId(props: DockProps): string | null {
  if (props.sessionsOpen) return 'sessions'
  if (props.inboxOpen) return 'inbox'
  if (props.chatOpen) return 'chat'
  if (props.centralOpen) return 'central'
  if (props.boardOpen) return 'board'
  return null
}

/**
 * Chrome kiri + bawah aplikasi.
 *
 * Activity bar 48px memuat permukaan (Sessions, Inbox, Chat, Board) dan aksi Add; lock/clean view
 * adalah toggle mode sehingga dirender sendiri dengan `aria-pressed`. Status bar 22px memuat
 * aksi kanvas (`Dock.statusBar.tsx`). Quick Pick Add tetap di sini karena tombol pembukanya ada di rail.
 */
export default function Dock(props: DockProps) {
  const [workspaceOpen, setWorkspaceOpen] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const { onAddBrowser, onToggleCentral } = props
  const { setOffer, dialog: offerDialog } = useCapabilityOffer(onAddBrowser, onToggleCentral)
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
    // cwd dibiarkan undefined: server memakai cwd workspace, sama seperti nodeterm yang
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
  const addItems = useMemo<VscodeQuickPickItem[]>(() => [
    { id: ADD_TERMINAL_ID, label: 'Terminal', icon: codicon('terminal') },
    { id: ADD_BROWSER_ID, label: 'Browser', icon: codicon('globe') },
    ...builtins.map((a) => {
      const cfg = agentConfig(a)
      return { id: `${ADD_BUILTIN_PREFIX}${a}`, label: cfg?.label ?? a, detail: cfg?.notice, icon: codicon('hubot') }
    }),
    ...visibleCustoms.map((c) => ({ id: `${ADD_CUSTOM_PREFIX}${c.id}`, label: c.label, icon: codicon('hubot') })),
    { id: ADD_WORKSPACE_ID, label: 'Workspace…', icon: codicon('new-folder') },
  ], [builtins, visibleCustoms])

  const onAddSelect = (id: string) => {
    if (id === ADD_TERMINAL_ID) return addTerminal()
    if (id === ADD_BROWSER_ID) {
      if (onAddBrowser) onAddBrowser()
      else setOffer('browser')
      return setAddOpen(false)
    }
    if (id === ADD_WORKSPACE_ID) return openWorkspaceForm()
    if (id.startsWith(ADD_BUILTIN_PREFIX)) return addBuiltin(id.slice(ADD_BUILTIN_PREFIX.length) as BuiltinAgentId)
    const custom = visibleCustoms.find((c) => `${ADD_CUSTOM_PREFIX}${c.id}` === id)
    if (custom) addCustom(custom)
  }

  const items: VscodeActivityBarItem[] = [
    { id: 'sessions', label: 'Toggle sessions panel', icon: codicon('layout-sidebar-left') },
    {
      id: 'inbox', label: 'Toggle inbox panel', icon: codicon('inbox'),
      badge: props.inboxUnread,
    },
    ...(props.onToggleChat
      ? [{ id: 'chat', label: 'Toggle chat panel', icon: codicon('comment-discussion') }]
      : []),
    { id: 'central', label: 'Toggle central control panel', icon: codicon('shield') },
    { id: 'board', label: 'Board', icon: codicon('project') },
    { id: 'add', label: 'Add node', icon: codicon('add') },
  ]

  const onActivitySelect = (id: string) => {
    switch (id) {
      case 'sessions':
        props.onToggleSessions()
        break
      case 'inbox':
        props.onToggleInbox()
        break
      case 'chat':
        props.onToggleChat?.()
        break
      case 'central':
        if (onToggleCentral) onToggleCentral()
        else setOffer('central')
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
        <VscodeActivityBar
          items={items}
          activeId={activeActivityId(props)}
          onSelect={onActivitySelect}
          ariaLabel="Activity bar"
        />

        {/* Grup bawah (ala "Manage" VS Code): Settings membuka dialog; lock dan clean view adalah
            toggle ber-`aria-pressed`, yang tidak dimiliki item navigasi activity bar. */}
        <div className="dock__modes" data-slot="dock-modes">
          {props.onOpenSettings && (
            <button
              type="button"
              className="vscode-activity-bar__item dock-btn"
              aria-label="Settings"
              title="Settings"
              onClick={props.onOpenSettings}
            >
              <span className="vscode-activity-bar__icon" aria-hidden>{codicon('settings-gear')}</span>
            </button>
          )}

          <button
            type="button"
            className="vscode-activity-bar__item dock-btn"
            aria-label={props.locked ? 'Unlock view' : 'Lock view'}
            title={props.locked ? 'Unlock view (pan/zoom)' : 'Lock view (pan/zoom); nodes stay movable'}
            aria-pressed={props.locked}
            onClick={props.onToggleLock}
          >
            <span className="vscode-activity-bar__icon" aria-hidden>{codicon(props.locked ? 'lock' : 'unlock')}</span>
          </button>

          <button
            type="button"
            className="vscode-activity-bar__item dock-btn"
            aria-label="Clean view"
            title="Clean view — hide all chrome (⌘./Ctrl+. to exit)"
            aria-pressed={props.cleanView}
            onClick={props.onToggleCleanView}
          >
            <span className="vscode-activity-bar__icon" aria-hidden>{codicon('eye-closed')}</span>
          </button>
        </div>

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
