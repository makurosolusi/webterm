// Profile chip in a browser node's header: the profile's color dot + name, and the menu that switches the node to
// another profile (checkmark on the current one, "live" and node count per row, New profile…, Manage profiles…).
// A switch moves the node: the server reopens its page on the last URL in that profile's browser. The server
// answers first, then the node's `profileId` is stored (so a refusal leaves the node and board untouched) and one
// notice reports the result; a failure has Retry.
import { useCallback, useState } from 'react'
import { useReactFlow } from '@xyflow/react'
import { Button } from '@/components/ui/button'
import { IconTooltip } from '@/components/ui/icon-button'
import { VscodeMenu } from './components/vscode/vscodeMenu'
import type { VscodeMenuItem } from './components/vscode/vscodeMenu'
import type { BrowserProfile } from '../shared/browser.profile'
import BrowserProfileCreateDialog from './BrowserProfileCreateDialog'
import { setNodeBrowserProfile } from './browserProfileApi'
import { ProfileDot, profileOfNode, useProfileList } from './browserProfile.list'
import { PROFILE_TEXT as T, profileErrorText } from './browserProfile.text'
import { useActiveWorkspaceId } from './activeWorkspace.context'
import { openSettingsAt } from './settings.link'
import { showNotice } from './workspaceSave.notice'

const noticeKey = (nodeId: string): string => `webterm-browser-profile-${nodeId}`

/** Menu rows for `profiles`: one per profile (dot, name, checkmark, live/nodes hint), then the actions. */
function menuItems(p: { profiles: BrowserProfile[]; current?: string; failed: boolean; onPick: (x: BrowserProfile) => void; onNew: () => void; onReload: () => void }): VscodeMenuItem[] {
  const rows: VscodeMenuItem[] = p.profiles.map((x) => ({
    type: 'item', id: `profile-${x.id}`, label: x.name, icon: <ProfileDot profile={x} />, checked: x.id === p.current,
    keybinding: T.rowHint(x) || undefined, title: [x.name, T.rowHint(x)].filter(Boolean).join(' · '), onSelect: () => p.onPick(x),
  }))
  if (p.failed) rows.push({ type: 'item', id: 'profiles-retry', label: `${T.listFailed} ${T.retry}`, onSelect: p.onReload })
  return [
    { type: 'header', label: T.menuHeader }, ...rows, { type: 'separator' },
    { type: 'item', id: 'profile-new', label: T.newProfile, icon: <span className="codicon codicon-add" aria-hidden="true" />, onSelect: p.onNew },
    { type: 'item', id: 'profile-manage', label: T.manage, icon: <span className="codicon codicon-settings-gear" aria-hidden="true" />, onSelect: () => openSettingsAt('browser', 'browser-profiles') },
  ]
}

/** Header chip of one browser node; `profileId` absent = the board's Default profile. */
export default function BrowserProfileChip({ nodeId, profileId }: { nodeId: string; profileId?: string }): React.JSX.Element {
  const rf = useReactFlow()
  const workspaceId = useActiveWorkspaceId() ?? ''
  const { profiles, error, reload } = useProfileList(workspaceId || undefined)
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null)
  const [creating, setCreating] = useState(false)
  const [busy, setBusy] = useState(false)
  const current = profileOfNode(profiles, workspaceId, profileId)
  const nodes = current?.nodeCount ?? 0

  const move = useCallback((to: BrowserProfile): void => {
    setBusy(true)
    setNodeBrowserProfile(nodeId, to.id).then(
      () => {
        // The board's Default stays "no profileId": a copied board must not point at another board's id.
        rf.updateNodeData(nodeId, { profileId: to.isDefaultOf === workspaceId ? undefined : to.id })
        showNotice(noticeKey(nodeId), { severity: 'info', title: T.moved(to.name) })
      },
      (e: unknown) => showNotice(noticeKey(nodeId), {
        severity: 'error', title: T.moveFailed(to.name, profileErrorText(e)), actions: [{ label: T.retry, onClick: () => move(to) }],
      }),
    ).finally(() => setBusy(false))
  }, [nodeId, workspaceId, rf])

  const name = current?.name ?? T.chipLoading
  return (
    <span className="nodrag inline-flex" data-browser-profile={current?.id}>
      <IconTooltip label={current ? T.chipTip(current.name, nodes) : T.sharedSession}>
        <Button
          type="button" size="xs" variant="ghost" className="max-w-36 gap-1 px-1" disabled={busy}
          aria-label={busy ? T.moving : T.chipLabel(name)} aria-haspopup="menu" aria-expanded={menuAt !== null} aria-busy={busy}
          onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMenuAt(menuAt ? null : { x: r.left, y: r.bottom }) }}
        >
          {busy ? <span className="codicon codicon-loading codicon-modifier-spin" aria-hidden="true" /> : <ProfileDot profile={current} />}
          <span className="truncate">{busy ? T.moving : name}</span>
          {nodes > 1 && <span className="tabular-nums text-(--vscode-descriptionForeground)" data-profile-nodes>{nodes}</span>}
        </Button>
      </IconTooltip>
      {menuAt && (
        <VscodeMenu
          open anchor={menuAt} minWidth={240} ariaLabel={T.menuLabel} onClose={() => setMenuAt(null)}
          items={menuItems({ profiles, current: current?.id, failed: error !== null, onPick: (x) => { if (x.id !== current?.id) move(x) }, onNew: () => setCreating(true), onReload: reload })}
        />
      )}
      {creating && (
        <BrowserProfileCreateDialog
          submitLabel={T.createAndSwitch}
          onClose={() => setCreating(false)} onCreated={(p) => { setCreating(false); reload(); move(p) }}
        />
      )}
    </span>
  )
}
