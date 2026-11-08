import type { ComponentRef, RefObject } from 'react'
import { Tree, TreeItem } from './vscode/register'
import { SessionGroupItem, SessionTreeItem, type RegisterTreeTarget } from './SessionRow'
import {
  projectCollapseKey,
  sessionLabel,
  signalCounts,
  type SidebarGrouping,
  type buildSessionList,
  type buildStatusList,
  type sidebarEmptyState,
} from './sessionList'
import type { ClosedEntry } from './closedHistory'

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
  closedSessions: ClosedEntry[]
  empty: ReturnType<typeof sidebarEmptyState>
  groupOpen: (key: string) => boolean
  projectOpen: (key: string) => boolean
  register: RegisterTreeTarget
  onCloseSession: (id: string) => void
}

/** Pohon sesi (tab project/status + seksi "Recently closed"); murni render dari props. */
export function SessionsTree({
  treeRef,
  grouping,
  sections,
  groups,
  closedSessions,
  empty,
  groupOpen,
  projectOpen,
  register,
  onCloseSession,
}: SessionsTreeProps) {
  return (
    <Tree
      ref={treeRef}
      className="ss-tree"
      indent={8}
      aria-label="Sessions tree"
    >
      {grouping === 'status' ? (
        // `buildStatusList` menahan SEMUA section supaya posisinya tetap; yang memutuskan mana
        // yang layak dirender adalah di sini. Section kosong disembunyikan — header "0" tidak
        // membawa apa pun dan tiga di antaranya memakan separuh panel. Satu pengecualian:
        // `attention`, karena nol di sana adalah kabar baik yang justru dicari pengguna, jadi
        // ketiadaannya tidak boleh dibaca sebagai "belum dihitung".
        empty === 'none' &&
        sections.filter((s) => s.kind === 'attention' || s.rows.length > 0).map((s) => (
          <SessionGroupItem
            key={s.kind}
            groupKey={`status:${s.kind}`}
            label={s.label}
            count={s.rows.length}
            open={groupOpen(`status:${s.kind}`)}
            register={register}
            icon={
              <span
                className={`codicon codicon-${s.kind === 'attention' ? 'bell' : 'circle-filled'} ss-status__icon ss-status__icon--${s.kind}`}
                aria-hidden
              />
            }
          >
            {s.rows.length > 0 && (
              s.rows.map((r) => (
                <SessionTreeItem
                  key={r.id}
                  row={r}
                  showProject
                  onCloseSession={onCloseSession}
                  register={register}
                />
              ))
            )}
          </SessionGroupItem>
        ))
      ) : (
        groups.map((g) => {
          const key = projectCollapseKey(g.projectId)
          const isCollapsed = !projectOpen(key)
          const sig = signalCounts(g.sessions)
          return (
            <SessionGroupItem
              key={g.projectId}
              groupKey={key}
              label={g.projectName}
              count={g.sessions.length}
              open={!isCollapsed}
              register={register}
              // Klik header berpindah board kalau board itu belum aktif; klik pada board yang
              // aktif hanya melipat/membukanya. Chevron tetap melipat board mana pun.
              workspace
              projectId={g.projectId}
              isActive={g.isActive}
              monogram={monogram(g.projectName)}
              color={g.projectColor}
              signals={sig}
            >
              {g.sessions.map((r) => (
                <SessionTreeItem
                  key={r.id}
                  row={r}
                  showProject={false}
                  onCloseSession={onCloseSession}
                  register={register}
                />
              ))}
            </SessionGroupItem>
          )
        })
      )}

      {/* Dirender HANYA bila ada isinya — dan di luar gerbang `empty`: board yang seluruh
          sesinya baru saja ditutup adalah justru saat daftar ini paling berguna. */}
      {closedSessions.length > 0 && (
        <SessionGroupItem
          groupKey={CLOSED_KEY}
          label="Recently closed"
          count={closedSessions.length}
          open={groupOpen(CLOSED_KEY)}
          register={register}
        >
          {closedSessions.map((e) => (
            <TreeItem
              key={e.node.id}
              className="ss-tree__leaf"
              aria-label={`Reopen ${sessionLabel(e.node)}`}
              title={e.node.cwd ?? ''}
              ref={(el) => register(el, { kind: 'reopen', id: e.node.id, path: e.node.cwd })}
            >
              <span className="ss-tree__label">{sessionLabel(e.node)}</span>
              {/* Nama workspace SELALU ikut: daftar ini meruntuhkan dinding workspace
                  seperti mode status, jadi tanpa itu barisnya tidak bilang akan muncul
                  kembali di board mana. */}
              <span slot="description" className="ss-meta">
                {e.workspaceName}
              </span>
            </TreeItem>
          ))}
        </SessionGroupItem>
      )}
    </Tree>
  )
}
