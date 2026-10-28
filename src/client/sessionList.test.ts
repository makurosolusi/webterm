import { describe, expect, it } from 'vitest'
import {
  buildSessionList,
  buildStatusList,
  isProjectCollapsed,
  projectCollapseKey,
  projectHeadClickAction,
  sessionLabel,
  sessionStatusGroup,
  sessionStatusKind,
  sidebarEmptyState,
  sidebarFilterKeyAction,
  signalCounts,
  STATE_LABEL,
} from './sessionList'
import { DEFAULT_VIEWPORT } from '../shared/workspace'
import type { AgentStatus, Workspace, WsNode } from '../shared/workspace'

// test-only: pabrik ringkas supaya setiap kasus hanya menyebut field yang diuji.
const node = (id: string, extra: Partial<WsNode> = {}): WsNode => ({
  id,
  kind: 'terminal',
  x: 0,
  y: 0,
  ...extra,
})

const ws = (id: string, name: string, nodes: WsNode[], extra: Partial<Workspace> = {}): Workspace => ({
  id,
  name,
  viewport: DEFAULT_VIEWPORT,
  nodes,
  bridges: [],
  updatedAt: 0,
  ...extra,
})

const noStatus: Record<string, AgentStatus> = {}

describe('sessionStatusKind', () => {
  it('melipat waiting dan blocked ke satu kind attention', () => {
    expect(sessionStatusKind('waiting')).toBe('attention')
    expect(sessionStatusKind('blocked')).toBe('attention')
  })

  it('memisahkan working dan done, dan jatuh ke unknown tanpa status', () => {
    expect(sessionStatusKind('working')).toBe('working')
    expect(sessionStatusKind('done')).toBe('done')
    expect(sessionStatusKind(undefined)).toBe('unknown')
  })
})

describe('STATE_LABEL', () => {
  it('memakai kalimat manusiawi, bukan enum huruf besar', () => {
    expect(STATE_LABEL).toEqual({
      working: 'Running',
      attention: 'Waiting for your response',
      done: 'Done',
      unknown: 'Unknown',
    })
  })
})

describe('sessionStatusGroup', () => {
  it('menaruh done di idle, bukan di attention', () => {
    expect(sessionStatusGroup('attention')).toBe('attention')
    expect(sessionStatusGroup('working')).toBe('working')
    expect(sessionStatusGroup('done')).toBe('idle')
    expect(sessionStatusGroup('unknown')).toBe('unknown')
  })
})

describe('sessionLabel', () => {
  it('mengutamakan judul, lalu label agent builtin, lalu id agent', () => {
    expect(sessionLabel(node('a', { title: '  Deploy  ' }))).toBe('Deploy')
    expect(sessionLabel(node('b', { kind: 'agent', agentId: 'claude' }))).toBe('Claude Code')
    expect(sessionLabel(node('c', { kind: 'agent', agentId: 'my-own-cli' }))).toBe('my-own-cli')
  })

  it('jatuh ke Terminal untuk shell tanpa judul', () => {
    expect(sessionLabel(node('d'))).toBe('Terminal')
    // Judul berisi spasi saja bukan judul.
    expect(sessionLabel(node('e', { title: '   ' }))).toBe('Terminal')
  })
})

describe('isProjectCollapsed', () => {
  const key = projectCollapseKey('p1')

  it('membuka hanya workspace aktif selagi belum ada pilihan pengguna', () => {
    expect(isProjectCollapsed({}, key, true)).toBe(false)
    expect(isProjectCollapsed({}, key, false)).toBe(true)
  })

  it('menghormati override eksplisit, termasuk yang melawan default', () => {
    expect(isProjectCollapsed({ [key]: true }, key, true)).toBe(true)
    expect(isProjectCollapsed({ [key]: false }, key, false)).toBe(false)
  })
})

describe('projectHeadClickAction', () => {
  it('berpindah bila belum aktif, melipat bila sudah aktif', () => {
    expect(projectHeadClickAction(false)).toBe('switch')
    expect(projectHeadClickAction(true)).toBe('toggle-collapse')
  })
})

describe('signalCounts', () => {
  it('menghitung attention dan working, mengabaikan done/unknown', () => {
    const rows = buildStatusList(
      [ws('p1', 'One', [node('a'), node('b'), node('c'), node('d')])],
      null,
      'p1',
      { a: 'waiting', b: 'blocked', c: 'working', d: 'done' },
      '',
    ).flatMap((s) => s.rows)
    expect(signalCounts(rows)).toEqual({ attention: 2, working: 1 })
  })
})

describe('buildSessionList', () => {
  const projects = [
    ws('p1', 'Alpha', [node('a1', { title: 'build' }), node('a2', { kind: 'files', dirPath: '/x' })]),
    ws('p2', 'Beta', [node('b1', { title: 'deploy', cwd: '/srv/beta' })], { cwd: '/srv/beta' }),
  ]

  it('mengelompokkan per workspace dan membuang node non-sesi', () => {
    const groups = buildSessionList(projects, null, 'p1', noStatus, '')
    expect(groups.map((g) => g.projectId)).toEqual(['p1', 'p2'])
    expect(groups[0].sessions.map((s) => s.id)).toEqual(['a1'])
    expect(groups[0].isActive).toBe(true)
    expect(groups[1].isActive).toBe(false)
  })

  it('memakai node live untuk workspace aktif, snapshot untuk yang lain', () => {
    const live = [node('a1', { title: 'renamed' }), node('a9', { title: 'brand new' })]
    const groups = buildSessionList(projects, live, 'p1', noStatus, '')
    expect(groups[0].sessions.map((s) => s.label)).toEqual(['renamed', 'brand new'])
    expect(groups[1].sessions.map((s) => s.label)).toEqual(['deploy'])
  })

  it('mencocokkan filter ke judul sesi dan cwd', () => {
    expect(
      buildSessionList(projects, null, 'p1', noStatus, 'depl').flatMap((g) => g.sessions.map((s) => s.id)),
    ).toEqual(['b1'])
    expect(
      buildSessionList(projects, null, 'p1', noStatus, '/srv').flatMap((g) => g.sessions.map((s) => s.id)),
    ).toEqual(['b1'])
  })

  it('menampilkan workspace yang namanya cocok secara utuh', () => {
    const groups = buildSessionList(projects, null, 'p1', noStatus, 'alpha')
    expect(groups.map((g) => g.projectId)).toEqual(['p1'])
    expect(groups[0].sessions.map((s) => s.id)).toEqual(['a1'])
  })

  it('menyembunyikan workspace tanpa hasil selagi memfilter, bukan saat kosong', () => {
    expect(buildSessionList(projects, null, 'p1', noStatus, 'zzz')).toEqual([])
    expect(buildSessionList(projects, null, 'p1', noStatus, '   ')).toHaveLength(2)
  })

  it('mewarisi cwd workspace untuk sesi tanpa cwd sendiri', () => {
    const groups = buildSessionList(projects, null, 'p2', noStatus, '')
    expect(groups[0].sessions[0].cwd).toBeUndefined() // Alpha tanpa cwd
    expect(groups[1].sessions[0].cwd).toBe('/srv/beta')
  })
})

describe('buildStatusList', () => {
  const projects = [
    ws('p1', 'Alpha', [node('a1', { title: 'zeta' }), node('a2', { title: 'alpha' })]),
    ws('p2', 'Beta', [node('b1', { title: 'beta' })]),
  ]

  it('meratakan semua workspace dan menaruh attention paling atas', () => {
    const sections = buildStatusList(projects, null, 'p1', { a1: 'working', a2: 'waiting', b1: 'done' }, '')
    expect(sections.map((s) => [s.kind, s.rows.map((r) => r.id)])).toEqual([
      ['attention', ['a2']],
      ['working', ['a1']],
      ['idle', ['b1']],
    ])
  })

  it('membuang section kosong', () => {
    const sections = buildStatusList(projects, null, 'p1', noStatus, '')
    expect(sections.map((s) => s.kind)).toEqual(['unknown'])
    expect(sections[0].label).toBe('Unknown')
  })

  it('mengurutkan dalam section per urutan workspace lalu judul', () => {
    const all: Record<string, AgentStatus> = { a1: 'working', a2: 'working', b1: 'working' }
    const rows = buildStatusList(projects, null, 'p1', all, '')[0].rows
    expect(rows.map((r) => r.id)).toEqual(['a2', 'a1', 'b1'])
  })

  it('tidak menduplikasi node saat node live masih milik workspace sebelumnya', () => {
    // Jendela nyata: activeProjectId sudah pindah ke p2 sementara liveActiveNodes masih
    // memegang node p1. Tanpa dedup, a1 terpancar di bawah Alpha DAN Beta.
    const live = [node('a1', { title: 'zeta' })]
    const rows = buildStatusList(projects, live, 'p2', noStatus, '')[0].rows
    expect(rows.filter((r) => r.id === 'a1')).toHaveLength(1)
  })

  it('membawa nama workspace di setiap baris', () => {
    const rows = buildStatusList(projects, null, 'p1', noStatus, '')[0].rows
    expect(rows.find((r) => r.id === 'b1')?.projectName).toBe('Beta')
  })

  it('menghormati filter, termasuk nama workspace sebagai pintu masuk', () => {
    // 'beta' tidak cocok judul mana pun di Alpha; ia masuk lewat nama workspace Beta.
    expect(buildStatusList(projects, null, 'p1', noStatus, 'beta').map((s) => s.rows.map((r) => r.id)))
      .toEqual([['b1']])
    expect(buildStatusList(projects, null, 'p1', noStatus, 'zet').flatMap((s) => s.rows.map((r) => r.id)))
      .toEqual(['a1'])
  })
})

describe('sidebarFilterKeyAction', () => {
  it('membersihkan hanya saat Escape pada field berisi', () => {
    expect(sidebarFilterKeyAction('Escape', 'abc')).toBe('clear')
    expect(sidebarFilterKeyAction('Escape', '')).toBe('ignore')
    expect(sidebarFilterKeyAction('Enter', 'abc')).toBe('ignore')
  })
})

describe('sidebarEmptyState', () => {
  it('membedakan "belum ada sesi" dari "tidak ada yang cocok"', () => {
    expect(sidebarEmptyState(false, '')).toBe('none')
    expect(sidebarEmptyState(true, '')).toBe('no-sessions')
    expect(sidebarEmptyState(true, '  ')).toBe('no-sessions')
    expect(sidebarEmptyState(true, 'zzz')).toBe('no-matches')
  })
})
