import type { Workspace } from '../shared/workspace'

interface Props {
  workspaces: Workspace[]
  activeId: string | null
  onSelect: (id: string) => void
}

export default function WorkspaceBar({ workspaces, activeId, onSelect }: Props) {
  return (
    <div className="ws-switcher">
      {workspaces.map((w) => (
        <button
          key={w.id}
          className={'ws-switcher-item' + (w.id === activeId ? ' ws-switcher-item--active' : '')}
          onClick={() => onSelect(w.id)}
        >
          {w.name}
        </button>
      ))}
    </div>
  )
}
