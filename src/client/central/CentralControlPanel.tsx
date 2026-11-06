// Body of the Central tab in the secondary side bar (`App.secondarySideBar`). Renders nothing
// unless the flag is on; opened from the Dock.
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { IconButton } from '@/components/ui/icon-button'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import AgentList from './AgentList'
import { ApprovalQueue } from './ApprovalCardR2'
import LevelPanel from './LevelPanel'
import MemoryView from './MemoryView'
import SkillReview from './SkillReview'
import { CL } from './centralLabels'
import { centralControlApi, useCentralControlEnabled } from './centralControlApi'
import type { CentralControlClient, StatusView } from './centralControlTypes'
import './central.css'

type TabId = 'control' | 'agents' | 'approvals' | 'skills' | 'memory'
const TABS = [
  { id: 'control', label: CL.tabControl },
  { id: 'agents', label: CL.tabAgents },
  { id: 'approvals', label: CL.tabApprovals },
  { id: 'skills', label: CL.tabSkills },
  { id: 'memory', label: CL.tabMemory },
]

export interface CentralControlPanelProps {
  open: boolean
  enabled?: boolean
  client?: CentralControlClient
  /** Host toolbar slot; the embedded refresh action is portaled here. */
  actionsHost?: HTMLElement | null
}

export default function CentralControlPanel({ open, enabled: enabledProp, client = centralControlApi, actionsHost }: CentralControlPanelProps) {
  const enabled = useCentralControlEnabled(enabledProp)
  const [tab, setTab] = useState<TabId>('control')
  const [status, setStatus] = useState<StatusView | null>(null)
  const [approvalsKey, setApprovalsKey] = useState(0)
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
          {tab === 'control' && <LevelPanel client={client} onStatus={setStatus} />}
          {tab === 'agents' && <AgentList client={client} onApprovalRequested={() => setApprovalsKey((k) => k + 1)} />}
          {tab === 'approvals' && <ApprovalQueue key={approvalsKey} client={client} />}
          {tab === 'skills' && <SkillReview client={client} />}
          {tab === 'memory' && <MemoryView client={client} />}
        </div>
      </div>
    </div>
  )
}
