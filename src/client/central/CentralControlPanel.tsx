// Body of the Central tab in the secondary side bar (`App.secondarySideBar`). Renders nothing
// unless the flag is on; opened from the Dock.
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { IconButton } from '@/components/ui/icon-button'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import AgentList from './AgentList'
import LevelPanel from './LevelPanel'
import AbilitiesView from './AbilitiesView'
import SkillReview from './SkillReview'
import { CL } from './centralLabels'
import { centralControlApi, useCentralControlEnabled } from './centralControlApi'
import type { CentralControlClient, StatusView } from './centralControlTypes'
import { type CentralTab, useCentralTabRequest } from '../secondarySideBar.store'
import './central.css'

type TabId = CentralTab
/** Last `/halt` request already turned into a confirmation, so a remount does not ask again. */
let haltSeen = 0
const TABS: { id: TabId; label: string }[] = [
  { id: 'status', label: CL.tabStatus },
  { id: 'abilities', label: CL.tabAbilities },
  { id: 'agents', label: CL.tabAgents },
  { id: 'skills', label: CL.tabSkills },
]

/** A tab this panel has; anything else (a removed tab such as the old Approvals or Memory) opens Status. */
export const knownTab = (tab: string | undefined): TabId => TABS.find((t) => t.id === tab)?.id ?? 'status'

export interface CentralControlPanelProps {
  open: boolean
  enabled?: boolean
  client?: CentralControlClient
  /** Host toolbar slot; the embedded refresh action is portaled here. */
  actionsHost?: HTMLElement | null
}

export default function CentralControlPanel({ open, enabled: enabledProp, client = centralControlApi, actionsHost }: CentralControlPanelProps) {
  const enabled = useCentralControlEnabled(enabledProp)
  // A Central chat command (`/status`, `/halt`) may pick the tab, also before this lazy panel mounted.
  const request = useCentralTabRequest()
  const [tab, setTab] = useState<TabId>(knownTab(request?.tab))
  const [askHalt, setAskHalt] = useState(false)
  useEffect(() => {
    if (!request) return
    setTab(knownTab(request.tab))
    if (request.halt && request.seq > haltSeen) { haltSeen = request.seq; setAskHalt(true) }
  }, [request])
  const [status, setStatus] = useState<StatusView | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  if (!enabled || !open) return null
  return (
    <div className="ccp-panel ccp-panel--embedded">
      {actionsHost && createPortal(
        <IconButton label={CL.refresh} size="icon-sm" onClick={() => setRefreshKey((k) => k + 1)}>
          <span className="codicon codicon-refresh" aria-hidden="true" />
        </IconButton>, actionsHost)}
      <div className="ccp-body">
        <Tabs value={tab} onValueChange={(id) => setTab(id as TabId)}>
          <TabsList aria-label={CL.tabsLabel}>
            {TABS.map((t) => <TabsTrigger key={t.id} value={t.id}>{t.label}</TabsTrigger>)}
          </TabsList>
        </Tabs>
        {status?.model.free && <p className="ccp-privacy" role="note">{CL.privacyLabel} ({status.model.id})</p>}
        {/* refreshKey remounts the active section so it reloads its data. */}
        <div key={`${tab}-${refreshKey}`} className="ccp-section-host">
          {tab === 'status' && <LevelPanel client={client} onStatus={setStatus} askHalt={askHalt} onHaltAsked={() => setAskHalt(false)} />}
          {tab === 'agents' && <AgentList client={client} />}
          {tab === 'skills' && <SkillReview client={client} />}
          {tab === 'abilities' && <AbilitiesView client={client} />}
        </div>
      </div>
    </div>
  )
}
