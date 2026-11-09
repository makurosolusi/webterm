// Always-mounted ⌘K/dialog hosts of the board, split out of App.tsx to keep it under the file-size limit.
// The hosts own their open state; App only feeds them the workspace context they need.
import TimelineHost from './Timeline'
import { BrowserLinkOfferHost } from './browserLinkOffer'
import { NodeCloseConfirmHost } from './nodeCloseConfirm'
import { ReopenConfirmHost } from './reopenConfirm'
import BakeoffHost from './bakeoff/BakeoffHost'
import ReplayHost from './replay/ReplayHost'
import TemplatesHost, { type TemplatesHostProps } from './templates/TemplatesHost'
import type { Workspace } from '../shared/workspace'

// Settings panel host (claudeLauncher/SettingsHost): re-exported here so App.tsx imports one hosts module.
export { default as SettingsHost } from './claudeLauncher/SettingsHost'

export interface AppHostsProps extends Pick<TemplatesHostProps, 'onCreated' | 'onPlace'> {
  activeWs: Workspace | null
}

/** Mounts the Timeline command and the ⌘K dialog hosts (browser offer, bake-off, replay, templates). */
export default function AppHosts({ activeWs, onCreated, onPlace }: AppHostsProps): React.JSX.Element {
  const activeId = activeWs?.id ?? null
  return (
    <>
      <TimelineHost />
      <NodeCloseConfirmHost />
      <ReopenConfirmHost />
      <BrowserLinkOfferHost />
      <BakeoffHost repo={activeWs?.cwd} workspaceId={activeId} />
      <ReplayHost workspaceId={activeId} nodes={(activeWs?.nodes ?? []).filter((n) => n.agentId)} />
      <TemplatesHost activeWs={activeWs} onCreated={onCreated} onPlace={onPlace} />
    </>
  )
}
