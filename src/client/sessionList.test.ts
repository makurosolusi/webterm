import { describe, expect, it } from 'vitest'
import {
  buildSessionList,
  buildStatusList,
  isProjectCollapsed,
  parseCollapsed,
  projectCollapseKey,
  projectHeadClickAction,
  rowMeta,
  sessionLabel,
  sessionStatusGroup,
  sessionStatusKind,
  sidebarEmptyState,
  sidebarFilterKeyAction,
  signalCounts,
  stateLabelOf,
  STATE_LABEL,
  STATUS_GROUP_LABEL,
  type SessionRowVM,
  type StatusGroup,
  type StatusSection,
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

// Bentuk LAMA: `stateLabel` barisnya dibaca dari `STATE_LABEL[statusKind]`, jadi `waiting` dan
// `blocked` sama-sama mengaku "Waiting for your response" — di `title` bel DAN di `aria-label`
// barisnya (`SessionRow.tsx`). Satu permukaan yang masih menggabungkan keduanya membuat chip node
// yang baru dipecah tak berguna.
const OLD_ROW_LABEL = (s: AgentStatus) => STATE_LABEL[sessionStatusKind(s)]

describe('stateLabelOf', () => {
  it('memisahkan blocked dari waiting, dan bentuk lama gagal guard ini', () => {
    expect(stateLabelOf('blocked')).toMatch(/approval/i)
    expect(stateLabelOf('blocked')).not.toBe(stateLabelOf('waiting'))
    expect(OLD_ROW_LABEL('waiting')).toBe(OLD_ROW_LABEL('blocked'))
    expect(stateLabelOf('waiting')).not.toBe(OLD_ROW_LABEL('waiting'))
  })

  it('status lain tetap memakai kalimat STATE_LABEL yang sudah ada', () => {
    expect(stateLabelOf('working')).toBe(STATE_LABEL.working)
    expect(stateLabelOf('done')).toBe(STATE_LABEL.done)
    expect(stateLabelOf(undefined)).toBe(STATE_LABEL.unknown)
  })
})

describe('STATUS_GROUP_LABEL', () => {
  it('menamai grup tanpa status dengan bahasa pengguna, bukan nama kind-nya', () => {
    // "Unknown" terbaca seperti kegagalan membaca sesuatu; yang sebenarnya ada di grup itu adalah
    // terminal biasa yang memang tidak punya status agent.
    expect(STATUS_GROUP_LABEL.unknown).toBe('No status')
    expect(STATUS_GROUP_LABEL.unknown).not.toBe('Unknown')
  })

  it('tooltip per baris TETAP memakai STATE_LABEL — dua peta, dua pembaca', () => {
    // Perubahan header tidak boleh ikut mengubah `stateLabel`, yang dipakai sebagai title glyph.
    expect(STATE_LABEL.unknown).toBe('Unknown')
  })
})

describe('rowMeta', () => {
  it('membuang pengulangan saat workspace dinamai sama dengan foldernya', () => {
    // Kasus nyatanya: board `wibu` dengan cwd berujung di folder `wibu` — `wibu · wibu` di layar
    // terbaca seperti bug.
    expect(rowMeta('wibu', '/Users/x/wibu')).toEqual(['wibu'])
  })

  it('menyebut keduanya saat memang dua fakta, nama workspace di depan', () => {
    expect(rowMeta('wibu', '/Users/x/api')).toEqual(['wibu', 'api'])
  })

  it('tinggal foldernya saat nama workspace tidak diminta', () => {
    // Mode project sudah menyebut nama board di header grupnya, jadi barisnya mengirim undefined.
    expect(rowMeta(undefined, '/Users/x/api')).toEqual(['api'])
  })

  it('tinggal nama workspace saat sesi tak punya cwd, dan kosong saat tak ada keduanya', () => {
    expect(rowMeta('wibu', undefined)).toEqual(['wibu'])
    expect(rowMeta(undefined, undefined)).toEqual([])
    expect(rowMeta('   ', '')).toEqual([])
  })

  it('memakai basename, bukan path penuh, dan tahan trailing slash', () => {
    expect(rowMeta(undefined, '/Users/x/api/')).toEqual(['api'])
    // Root tak punya basename; path itu sendiri yang dipakai, karena "/" memang nama yang benar.
    expect(rowMeta(undefined, '/')).toEqual(['/'])
  })
})

describe('sessionStatusGroup', () => {
  it('menaruh done di idle, bukan di attention', () => {
    expect(sessionStatusGroup('attention', false)).toBe('attention')
    expect(sessionStatusGroup('working', false)).toBe('working')
    expect(sessionStatusGroup('done', false)).toBe('idle')
    expect(sessionStatusGroup('unknown', false)).toBe('unknown')
  })

  it('menaruh yang belum dibaca di unread, termasuk yang tanpa sinyal hook', () => {
    expect(sessionStatusGroup('done', true)).toBe('unread')
    expect(sessionStatusGroup('unknown', true)).toBe('unread')
  })

  it('attention dan working mengalahkan tanda unread', () => {
    // Prioritas keanggotaan, bukan urutan tampil: turn BARU yang sedang jalan tetap di Running,
    // lalu muncul lagi sebagai Unread begitu turn itu berakhir.
    expect(sessionStatusGroup('attention', true)).toBe('attention')
    expect(sessionStatusGroup('working', true)).toBe('working')
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

  it('terbuka selagi pengguna belum memilih apa pun', () => {
    expect(isProjectCollapsed({}, key)).toBe(false)
  })

  it('hanya pilihan pengguna yang melipat — berpindah board tidak menutup board lain', () => {
    const user = { [projectCollapseKey('p2')]: true }
    // p2 ditutup manual dan tetap tertutup; p1 tak pernah disentuh, jadi tetap terbuka
    // walau board aktif berganti ke mana pun.
    expect(isProjectCollapsed(user, projectCollapseKey('p2'))).toBe(true)
    expect(isProjectCollapsed(user, key)).toBe(false)
    expect(isProjectCollapsed({ [key]: false }, key)).toBe(false)
  })
})

describe('parseCollapsed', () => {
  it('mengembalikan peta lipatan yang tersimpan', () => {
    expect(parseCollapsed('{"project:p1":true,"closed":false}')).toEqual({
      'project:p1': true,
      closed: false,
    })
  })

  it('jatuh ke peta kosong untuk penyimpanan kosong atau rusak, tanpa melempar', () => {
    expect(parseCollapsed(null)).toEqual({})
    expect(parseCollapsed('')).toEqual({})
    expect(parseCollapsed('{oops')).toEqual({})
    expect(parseCollapsed('"project:p1"')).toEqual({})
    expect(parseCollapsed('[true]')).toEqual({})
    expect(parseCollapsed('null')).toEqual({})
  })

  it('membuang nilai non-boolean alih-alih meneruskannya sebagai keadaan lipatan', () => {
    expect(parseCollapsed('{"project:p1":"true","project:p2":1,"project:p3":true}')).toEqual({
      'project:p3': true,
    })
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

  it('menganggap baris sudah dibaca bila himpunan unread tidak disebut', () => {
    // Default itu yang membuat pemanggil mode-project (mis. tab workspace) tak perlu tahu soal
    // kanal baca sama sekali.
    expect(buildSessionList(projects, null, 'p1', noStatus, '')[0].sessions[0].unread).toBe(false)
    expect(
      buildSessionList(projects, null, 'p1', noStatus, '', new Set(['a1']))[0].sessions[0].unread,
    ).toBe(true)
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

  // test-only: section tidak lagi dibuang saat kosong, jadi kasus di bawah menyebut section yang
  // diuji alih-alih mengandalkan posisi [0].
  const rowsOf = (sections: StatusSection[], kind: StatusGroup): SessionRowVM[] =>
    sections.find((s) => s.kind === kind)?.rows ?? []

  it('meratakan semua workspace dan menaruh attention paling atas', () => {
    const sections = buildStatusList(projects, null, 'p1', { a1: 'working', a2: 'waiting', b1: 'done' }, '')
    expect(sections.map((s) => [s.kind, s.rows.map((r) => r.id)])).toEqual([
      ['attention', ['a2']],
      ['unread', []],
      ['working', ['a1']],
      ['idle', ['b1']],
      ['unknown', []],
    ])
  })

  it('menaruh Unread tepat di bawah attention, dan hanya yang turn-nya sudah berakhir', () => {
    // a1 bertanda tapi turn barunya jalan → tetap Running; a2 bertanda dan sudah selesai → Unread;
    // b1 selesai tanpa tanda → Idle.
    const sections = buildStatusList(
      projects,
      null,
      'p1',
      { a1: 'working', a2: 'done', b1: 'done' },
      '',
      new Set(['a1', 'a2']),
    )
    expect(sections.map((s) => [s.kind, s.rows.map((r) => r.id)])).toEqual([
      ['attention', []],
      ['unread', ['a2']],
      ['working', ['a1']],
      ['idle', ['b1']],
      ['unknown', []],
    ])
  })

  it('membawa tanda unread ke barisnya, supaya glyph bisa membedakannya dari done biasa', () => {
    const rows = buildStatusList(projects, null, 'p1', { a1: 'done', b1: 'done' }, '', new Set(['a1']))
      .flatMap((s) => s.rows)
    expect(rows.find((r) => r.id === 'a1')?.unread).toBe(true)
    expect(rows.find((r) => r.id === 'b1')?.unread).toBe(false)
  })

  it('menahan section kosong, dengan label dan hitungan nol', () => {
    // Kelima section selalu hadir dalam urutan tetap: posisi section tidak boleh bergeser saat
    // satu sesi berganti status, dan "0" itu sendiri jawaban yang perlu dibaca.
    const sections = buildStatusList(projects, null, 'p1', noStatus, '')
    expect(sections.map((s) => [s.kind, s.label, s.rows.length])).toEqual([
      ['attention', 'Need attention', 0],
      ['unread', 'Unread', 0],
      ['working', 'Running', 0],
      ['idle', 'Idle', 0],
      ['unknown', 'No status', 3],
    ])
  })

  it('tetap mengembalikan kelima section walau filter tak cocok sama sekali', () => {
    const sections = buildStatusList(projects, null, 'p1', noStatus, 'zzz')
    expect(sections.map((s) => s.kind)).toEqual(['attention', 'unread', 'working', 'idle', 'unknown'])
    expect(sections.every((s) => s.rows.length === 0)).toBe(true)
  })

  it('mengurutkan dalam section per urutan workspace lalu judul', () => {
    const all: Record<string, AgentStatus> = { a1: 'working', a2: 'working', b1: 'working' }
    const rows = rowsOf(buildStatusList(projects, null, 'p1', all, ''), 'working')
    expect(rows.map((r) => r.id)).toEqual(['a2', 'a1', 'b1'])
  })

  it('tidak menduplikasi node saat node live masih milik workspace sebelumnya', () => {
    // Jendela nyata: activeProjectId sudah pindah ke p2 sementara liveActiveNodes masih
    // memegang node p1. Tanpa dedup, a1 terpancar di bawah Alpha DAN Beta.
    const live = [node('a1', { title: 'zeta' })]
    const rows = rowsOf(buildStatusList(projects, live, 'p2', noStatus, ''), 'unknown')
    expect(rows.filter((r) => r.id === 'a1')).toHaveLength(1)
  })

  it('membawa nama workspace di setiap baris', () => {
    const rows = rowsOf(buildStatusList(projects, null, 'p1', noStatus, ''), 'unknown')
    expect(rows.find((r) => r.id === 'b1')?.projectName).toBe('Beta')
  })

  it('menghormati filter, termasuk nama workspace sebagai pintu masuk', () => {
    // 'beta' tidak cocok judul mana pun di Alpha; ia masuk lewat nama workspace Beta.
    expect(buildStatusList(projects, null, 'p1', noStatus, 'beta').flatMap((s) => s.rows.map((r) => r.id)))
      .toEqual(['b1'])
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
