// Overlays hosted by the workspace bar: `+` menu, color picker, workspace create flow, tab menu.
import type { ReactNode } from 'react'
import NodeContextMenu from './NodeContextMenu'
import type { SessionGroup } from './sessionList'
import { useNotifyPrefs } from './osNotify.prefs'
import { WorkspaceColorHost } from './WorkspaceColorPicker'
import { WorkspaceTabMenu } from './WorkspaceTabMenu'
import WorkspaceCreateHost, { openWorkspaceCreate } from './workspaceCreate/WorkspaceCreateHost'
import type { PointAt } from './useWorkspaceTabActions'
import type { ColorChange } from './api'
import type { Workspace } from '../shared/workspace'

export interface WorkspaceBarHostsProps {
  workspaces: Workspace[]
  groups: SessionGroup[]
  activeId: string | null
  addMenu: PointAt | null
  menu: ({ id: string } & PointAt) | null
  colorId: string | null
  onCloseAddMenu: () => void
  onCloseMenu: () => void
  onCloseColor: () => void
  onColor: (id: string) => void
  onRename: (id: string) => void
  onDelete: (id: string, name: string, sessions: number) => void
  onSelect: (id: string) => void
  onNewWorkspace: (path?: string) => void
  onSetWorkspaceColor?: (id: string, change: ColorChange) => void | Promise<unknown>
}

export function WorkspaceBarHosts(p: WorkspaceBarHostsProps): ReactNode {
  const mutedIds = useNotifyPrefs().muted
  const colorWs = p.colorId ? p.workspaces.find((w) => w.id === p.colorId) ?? null : null
  const menuGroup = p.menu ? p.groups.find((g) => g.projectId === p.menu?.id) ?? null : null
  return (
    <>
      {p.addMenu && (
        <NodeContextMenu
          x={p.addMenu.x}
          y={p.addMenu.y}
          rows={[
            { label: 'Open Folder…', onClick: () => p.onNewWorkspace() },
            { label: 'Clone Repository…', onClick: () => openWorkspaceCreate('clone') },
            { label: 'New Project…', onClick: () => openWorkspaceCreate('project') },
          ]}
          onClose={p.onCloseAddMenu}
        />
      )}
      {p.onSetWorkspaceColor && <WorkspaceColorHost workspace={colorWs} onClose={p.onCloseColor} onSet={p.onSetWorkspaceColor} />}
      <WorkspaceCreateHost onOpenFolder={() => p.onNewWorkspace()} onCreated={(path) => p.onNewWorkspace(path)} onOpenWorkspace={p.onSelect} />

      {p.menu && menuGroup && (
        <WorkspaceTabMenu
          x={p.menu.x} y={p.menu.y} projectId={menuGroup.projectId} muted={mutedIds.includes(menuGroup.projectId)} isActive={menuGroup.projectId === p.activeId}
          onSelect={p.onSelect} onRename={() => p.onRename(menuGroup.projectId)} onClose={p.onCloseMenu}
          onColor={p.onSetWorkspaceColor ? () => p.onColor(menuGroup.projectId) : undefined}
          onDelete={() => p.onDelete(menuGroup.projectId, menuGroup.projectName, menuGroup.sessions.length)}
        />
      )}
    </>
  )
}
