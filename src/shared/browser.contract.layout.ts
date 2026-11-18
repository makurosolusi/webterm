// Agent-facing shapes of the layout / tabs / `all` verbs (split out of browser.contract.ts). Declarations only.
import type { AgentTabView } from './browser.agentTabs'

/** One pane of a layout as an agent sees it. */
export interface LayoutPane { tab: string; title: string; host: string; /** The human's focused pane. */ focus: boolean; w: number; h: number; device?: string }
/** The node's split layout: `tree` like `h(t1, v(t2, t3))` (`t1` alone = no split), panes in reading order, and sync mode. */
export interface LayoutData { tree: string; split: boolean; panes: LayoutPane[]; sync: boolean; maxPanes: number }
/** Result of one tab in an `all` run; verb-specific fields (`url`, `content`, `base64`, ...) ride along. A failed tab never fails the others. */
export interface TabResult { tab: string; ok: boolean; name?: string; error?: string; message?: string; [field: string]: unknown }
export interface AllData { all: true; results: TabResult[]; okCount: number; failedCount: number; note?: string }
/** Tab list a verb answers with: the node's tabs, the agent's working tab and the per-node limit. */
export interface TabsData { tabs: AgentTabView[]; agentTab: string | null; max: number }
