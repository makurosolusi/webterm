// Bottom panel host for the central control surface. Renders nothing unless the flag is on, so
// the old UI is identical by default. Mounted by App; opened from the Dock.
import { useCallback, useState } from 'react'
import type { BottomPanelTab } from '../bottomPanelTabs'
import { InboxPanelSurface } from '../inboxPanelSurface'
import AgentList from './AgentList'
import { ApprovalQueue } from './ApprovalCardR2'
import LevelPanel from './LevelPanel'
import MemoryView from './MemoryView'
import SkillReview from './SkillReview'
import { CL } from './centralLabels'
import { centralControlApi, useCentralControlEnabled } from './centralControlApi'
import type { CentralControlClient, StatusView } from './centralControlTypes'
import './central.css'

const OPEN_KEY = 'webterm.centralControlOpen'
type TabId = 'control' | 'agents' | 'approvals' | 'skills' | 'memory'
const TABS: BottomPanelTab[] = [
  { id: 'control', label: CL.tabControl, closable: false },
  { id: 'agents', label: CL.tabAgents, closable: false },
  { id: 'approvals', label: CL.tabApprovals, closable: false },
  { id: 'skills', label: CL.tabSkills, closable: false },
  { id: 'memory', label: CL.tabMemory, closable: false },
]

/** Flag plus persisted open state for the Dock toggle; `enabled` false means App wires nothing. */
export function useCentralControl(override?: boolean) {
  const enabled = useCentralControlEnabled(override)
  // Flag dimuat async dari server, jadi state buka dibaca tanpa gerbang `enabled`; `open` di bawah yang menggerbangi.
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem(OPEN_KEY) === '1' } catch { return false }
  })
  const set = useCallback((next: boolean) => {
    setOpen(next)
    try { localStorage.setItem(OPEN_KEY, next ? '1' : '0') } catch { /* private mode: lasts this tab only */ }
  }, [])
  return { enabled, open: enabled && open, toggle: () => set(!open), close: () => set(false) }
}

export interface CentralControlPanelProps {
  open: boolean
  onClose: () => void
  enabled?: boolean
  client?: CentralControlClient
}

export default function CentralControlPanel({ open, onClose, enabled: enabledProp, client = centralControlApi }: CentralControlPanelProps) {
  const enabled = useCentralControlEnabled(enabledProp)
  const [tab, setTab] = useState<TabId>('control')
  const [status, setStatus] = useState<StatusView | null>(null)
  const [approvalsKey, setApprovalsKey] = useState(0)
  if (!enabled || !open) return null
  return (
    <InboxPanelSurface className="ccp-panel" ariaLabel={CL.panelTitle} tabsLabel={CL.tabsLabel} tabs={TABS} activeId={tab} onActivate={(id) => setTab(id as TabId)} onClosePanel={onClose}>
      <div className="ccp-body">
        {status?.model.free && <p className="ccp-privacy" role="note">{CL.privacyLabel} ({status.model.id})</p>}
        {tab === 'control' && <LevelPanel client={client} onStatus={setStatus} />}
        {tab === 'agents' && <AgentList client={client} onApprovalRequested={() => setApprovalsKey((k) => k + 1)} />}
        {tab === 'approvals' && <ApprovalQueue key={approvalsKey} client={client} />}
        {tab === 'skills' && <SkillReview client={client} />}
        {tab === 'memory' && <MemoryView client={client} />}
      </div>
    </InboxPanelSurface>
  )
}
