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
import type { buildNodeGroups } from './nodeList'
import type { ClosedEntry } from './closedHistory'
import type { WsNodeKind } from '../shared/workspace'

/** Codicon per kind untuk branch tab Nodes. Baris di sana tidak punya status, jadi slot ikonnya
 *  kosong — dan bentuk adalah satu-satunya pembeda yang terbaca tanpa membaca: judul kustom
 *  ("notes", "scratch") sama-sama mungkin milik editor, terminal, atau folder. */
const KIND_ICON: Record<WsNodeKind, string> = {
  agent: 'hubot',
  terminal: 'terminal',
  editor: 'file',
  files: 'folder',
  browser: 'globe',
  diff: 'git-compare',
  plan: 'type-hierarchy',
  app: 'window',
}

/** Glyph kind (codicon) untuk header grup dan baris tab Nodes. */
function KindIcon({ kind }: { kind: WsNodeKind }) {
  return <span className={`codicon codicon-${KIND_ICON[kind]}`} aria-hidden />
}

/** Kunci disclosure seksi "Recently closed", berbagi `collapsed` dengan baris workspace. Tidak bisa
 *  bertabrakan: kunci workspace selalu berawalan `project:` (lihat `projectCollapseKey`). */
export const CLOSED_KEY = 'closed'

function monogram(name: string): string {
  return (name.trim()[0] ?? '?').toUpperCase()
}

export interface SessionsTreeProps {
  treeRef: RefObject<ComponentRef<typeof Tree> | null>
  grouping: SidebarGrouping
  nodeGroups: ReturnType<typeof buildNodeGroups>
  sections: ReturnType<typeof buildStatusList>
  groups: ReturnType<typeof buildSessionList>
  closedSessions: ClosedEntry[]
  empty: ReturnType<typeof sidebarEmptyState>
  groupOpen: (key: string) => boolean
  projectOpen: (key: string) => boolean
  register: RegisterTreeTarget
  onCloseSession: (id: string) => void
}

/** Pohon sesi (tab project/status/nodes + seksi "Recently closed"); murni render dari props. */
export function SessionsTree({
  treeRef,
  grouping,
  nodeGroups,
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
      aria-label={`${grouping === 'nodes' ? 'Nodes' : 'Sessions'} tree`}
    >
      {/* Satu-satunya daftar yang memuat node files/editor juga — jadi satu-satunya jalan
          memusatkan canvas ke node yang bukan shell. */}
      {grouping === 'nodes' ? (
        nodeGroups.map((g) => {
          return (
            <SessionGroupItem
              key={g.kind}
              groupKey={`nodes:${g.kind}`}
              label={g.label}
              count={g.rows.length}
              open={groupOpen(`nodes:${g.kind}`)}
              register={register}
              icon={<KindIcon kind={g.kind} />}
            >
              {g.rows.map((r) => (
                <TreeItem
                  key={r.id}
                  className="ss-tree__leaf"
                  aria-label={`Focus ${r.label}`}
                  title={r.detail ?? ''}
                  ref={(el) => register(el, { kind: 'node', id: r.id, path: r.detail })}
                >
                  <span slot="icon-leaf" className="ss-tree__kind" aria-hidden>
                    <KindIcon kind={g.kind} />
                  </span>
                  {/* Tanpa meta: satu board saja (nama workspace sama di tiap baris), dan
                      kind sudah disebut header seksi + ikon. */}
                  <span className="ss-tree__label">{r.label}</span>
                </TreeItem>
              ))}
            </SessionGroupItem>
          )
        })
      ) : grouping === 'status' ? (
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
      {grouping !== 'nodes' && closedSessions.length > 0 && (
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
