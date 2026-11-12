// Body of the Control tab in the secondary side bar (`App.secondarySideBar`), opened from the Dock. With Central
// off only the tabs that work without it (`CENTRAL_FREE_TABS`: memory, automations, spending) are shown.
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { IconButton } from '@/components/ui/icon-button'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import AgentList from './AgentList'
import LevelPanel from './LevelPanel'
import AbilitiesView from './AbilitiesView'
import SkillReview from './SkillReview'
import MemoryTab from './MemoryTab'
import { RoutinesPanel } from '../RoutinesPanel'
import { CostPanel } from '../CostPanel'
import HealthView from './health/HealthView'
import { HL } from './health/healthModel'
import { CL } from './centralLabels'
import { centralControlApi, useCentralControlEnabled } from './centralControlApi'
import type { CentralControlClient, StatusView } from './centralControlTypes'
import { useCentralTabRequest, useSideBar } from '../secondarySideBar.store'
import { CENTRAL_FREE_TABS, CENTRAL_PANEL_TABS, type CentralPanelTab } from './centralTabs'
import './central.css'

type TabId = CentralPanelTab
/** Last `/halt` request already turned into a confirmation, so a remount does not ask again. */
let haltSeen = 0
const TAB_LABELS: Record<TabId, string> = {
  status: CL.tabStatus, abilities: CL.tabAbilities, agents: CL.tabAgents, skills: CL.tabSkills, memory: CL.tabMemory, automations: CL.tabAutomations, spending: CL.tabSpending, health: HL.tab,
}
const TABS = CENTRAL_PANEL_TABS.map((id) => ({ id, label: TAB_LABELS[id] }))

/** A tab this panel has; anything else (a removed tab such as the old Approvals) opens Status. */
export const knownTab = (tab: string | undefined): TabId => TABS.find((t) => t.id === tab)?.id ?? 'status'

export interface CentralControlPanelProps {
  open: boolean
  enabled?: boolean
  client?: CentralControlClient
  /** Host toolbar slot; the embedded refresh action is portaled here. */
  actionsHost?: HTMLElement | null
  /** Controlled tab (the URL's `?ctab=`); with it, tab changes go to `onTabChange`. */
  tab?: TabId
  onTabChange?: (tab: TabId) => void
}

export default function CentralControlPanel({ open, enabled: enabledProp, client = centralControlApi, actionsHost, tab: tabProp, onTabChange }: CentralControlPanelProps) {
  const enabled = useCentralControlEnabled(enabledProp)
  // A Central chat command (`/status`, `/halt`) may pick the tab, also before this lazy panel mounted.
  const request = useCentralTabRequest()
  // The side bar keeps this panel mounted behind Chat, so "shown" is its view, not whether it is mounted.
  const sideBar = useSideBar()
  const visible = sideBar.open && sideBar.view === 'central'
  const [ownTab, setOwnTab] = useState<TabId>(knownTab(request?.tab))
  const tab = tabProp ?? ownTab
  const setTab = (id: TabId): void => { setOwnTab(id); onTabChange?.(id) }
  const [askHalt, setAskHalt] = useState(false)
  useEffect(() => {
    if (!request) return
    // Own state only: `openCentralTab` already wrote the URL, and a remount must not replay an old request into it.
    setOwnTab(knownTab(request.tab))
    if (request.halt && request.seq > haltSeen) { haltSeen = request.seq; setAskHalt(true) }
  }, [request])
  const [status, setStatus] = useState<StatusView | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  // Tabs that do not fit scroll inside the strip (like the editor tab strip); keep the active one in view.
  // jsdom has no scrollIntoView; browsers do.
  useEffect(() => {
    listRef.current?.querySelector('[data-state="active"]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [tab, enabled, open])
  if (!open) return null
  // Central off: only the tabs that work without it; a tab it cannot show falls back to the first one.
  const tabs = enabled ? TABS : TABS.filter((t) => CENTRAL_FREE_TABS.includes(t.id))
  const shown = tabs.find((t) => t.id === tab)?.id ?? tabs[0]!.id
  return (
    <div className="ccp-panel ccp-panel--embedded">
      {actionsHost && createPortal(
        <IconButton label={CL.refresh} size="icon-sm" onClick={() => setRefreshKey((k) => k + 1)}>
          <span className="codicon codicon-refresh" aria-hidden="true" />
        </IconButton>, actionsHost)}
      {/* Pinned header: only the body below scrolls (VS Code / DevTools). */}
      <Tabs value={shown} onValueChange={(id) => setTab(id as TabId)} className="ccp-tabs">
        <TabsList ref={listRef} aria-label={CL.tabsLabel} className="ccp-tabs__list w-full justify-start">
          {tabs.map((t) => <TabsTrigger key={t.id} value={t.id} className="flex-none">{t.label}</TabsTrigger>)}
        </TabsList>
      </Tabs>
      <div className="ccp-body" data-testid="ccp-scroll">
        {status?.model.free && <p className="ccp-privacy" role="note">{CL.privacyLabel} ({status.model.id})</p>}
        {/* refreshKey remounts the active section so it reloads its data. */}
        <div key={`${shown}-${refreshKey}`} className="ccp-section-host">
          {shown === 'status' && <LevelPanel client={client} visible={visible} onStatus={setStatus} askHalt={askHalt} onHaltAsked={() => setAskHalt(false)} />}
          {shown === 'agents' && <AgentList client={client} visible={visible} />}
          {shown === 'skills' && <SkillReview client={client} />}
          {shown === 'abilities' && <AbilitiesView client={client} />}
          {shown === 'memory' && <MemoryTab client={client} central={enabled} />}
          {shown === 'automations' && <RoutinesPanel />}
          {shown === 'spending' && <CostPanel />}
          {shown === 'health' && <HealthView visible={visible} />}
        </div>
      </div>
    </div>
  )
}
