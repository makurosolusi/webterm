import type { ComponentRef, RefObject } from 'react'
import { Tree } from './vscode/register'
import { ClosedTreeItem, SessionTreeItem, type RegisterTreeTarget, type TreeTarget } from './SessionRow'
import { SessionGroupItem } from './SessionGroupItem'
import { projectCollapseKey, signalCounts, type SessionRowVM, type SidebarGrouping, type buildSessionList, type buildStatusList } from './sessionList'
import { BUCKET_ICON } from './sessionList.row'
import { workspaceSubline } from './sessionList.workspace'
import type { ClosedEntry } from './closedHistory'
import './sessions-panel.workspace.css'

/** Kunci disclosure seksi "Recently closed", berbagi `collapsed` dengan baris workspace. Tidak bisa
 *  bertabrakan: kunci workspace selalu berawalan `project:` (lihat `projectCollapseKey`). */
export const CLOSED_KEY = 'closed'

function monogram(name: string): string {
  return (name.trim()[0] ?? '?').toUpperCase()
}

export interface SessionsTreeProps {
  treeRef: RefObject<ComponentRef<typeof Tree> | null>
  grouping: SidebarGrouping
  sections: ReturnType<typeof buildStatusList>
  groups: ReturnType<typeof buildSessionList>
  /** Already filtered; Project tab only (Status is live triage, closed sessions have no status). */
  closedSessions: ClosedEntry[]
  groupOpen: (key: string) => boolean
  projectOpen: (key: string) => boolean
  register: RegisterTreeTarget
  now: number
  onCloseSession: (id: string) => void
  onSelectWorkspace: (id: string) => void
  /** Absent for a row = not renamable here (only the open board's nodes can be). */
  renameOf: (row: SessionRowVM) => ((row: SessionRowVM) => void) | undefined
  onMoreActions: (target: TreeTarget, anchor: { x: number; y: number }) => void
  onRestore: (id: string) => void
  /** Git branch by workspace cwd (`useGitBranches`); absent = unknown, the header shows none. */
  branches: Record<string, string>
}

/** Pohon sesi (tab project/status + seksi "Recently closed"); murni render dari props. */
export function SessionsTree(p: SessionsTreeProps) {
  const leaf = (r: SessionRowVM, mode: 'project' | 'status', groupCwd?: string) => (
    <SessionTreeItem
      key={r.id}
      row={r}
      mode={mode}
      groupCwd={groupCwd}
      now={p.now}
      onCloseSession={p.onCloseSession}
      onRename={p.renameOf(r)}
      onMoreActions={p.onMoreActions}
      register={p.register}
    />
  )
  return (
    <Tree ref={p.treeRef} className="ss-tree" indent={8} aria-label="Sessions tree">
      {p.grouping === 'status'
        ? // `buildStatusList` returns only non-empty buckets, in lifecycle order.
          p.sections.map((s) => (
            <SessionGroupItem
              key={s.bucket}
              groupKey={`status:${s.bucket}`}
              label={s.label}
              count={s.rows.length}
              open={p.groupOpen(`status:${s.bucket}`)}
              register={p.register}
              icon={
                <span
                  className={`codicon codicon-${BUCKET_ICON[s.bucket]}${s.bucket === 'working' ? ' codicon-modifier-spin' : ''} ss-status__icon ss-status__icon--${s.bucket}`}
                  aria-hidden
                />
              }
            >
              {s.rows.map((r) => leaf(r, 'status'))}
            </SessionGroupItem>
          ))
        : p.groups.map((g) => {
            const key = projectCollapseKey(g.projectId)
            return (
              <SessionGroupItem
                key={g.projectId}
                groupKey={key}
                label={g.projectName}
                count={g.sessions.length}
                open={p.projectOpen(key)}
                register={p.register}
                // Header click only expands/collapses; switching is the inline action (or menu), or
                // a session row. Every workspace is listed, so a switch never reshapes this tree.
                workspace
                projectId={g.projectId}
                isActive={g.isActive}
                onSwitchWorkspace={p.onSelectWorkspace}
                monogram={monogram(g.projectName)}
                color={g.projectColor}
                attention={signalCounts(g.sessions).attention}
                sub={workspaceSubline(g.cwd, g.cwd ? p.branches[g.cwd] : undefined)}
              >
                {g.sessions.map((r) => leaf(r, 'project', g.cwd))}
              </SessionGroupItem>
            )
          })}

      {/* Rendered only with entries, and even when no live session is left: a board whose sessions
          were all just closed is exactly when this list is most useful. Collapsed by default. */}
      {p.grouping === 'project' && p.closedSessions.length > 0 && (
        <SessionGroupItem
          groupKey={CLOSED_KEY}
          label="Recently closed"
          count={p.closedSessions.length}
          open={p.groupOpen(CLOSED_KEY)}
          register={p.register}
          icon={<span className="codicon codicon-history" aria-hidden />}
        >
          {p.closedSessions.map((e) => (
            <ClosedTreeItem key={e.node.id} entry={e} now={p.now} onRestore={p.onRestore} register={p.register} />
          ))}
        </SessionGroupItem>
      )}
    </Tree>
  )
}
