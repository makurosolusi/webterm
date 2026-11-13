import { describe, expect, it } from 'vitest'
import {
  buildSessionList,
  buildStatusList,
  isProjectCollapsed,
  parseCollapsed,
  projectCollapseKey,
  rowMeta,
  sessionIds,
  sessionLabel,
  sidebarEmptyState,
  sidebarFilterKeyAction,
  signalCounts,
  type SessionRowVM,
  type StatusSection,
} from './sessionList'
import type { StatusBucket } from './sessionStatus.model'
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

// The old vocabulary (sessionStatusKind / STATE_LABEL / STATUS_GROUP_LABEL) folded `waiting`
// (turn ended) and `failed` into "Need attention" and left live sessions in "No status". Rows now
// read the shared model; these pin that a row's view is the model's, not a local rule.
describe('row status comes from the shared model', () => {
  const one = (status: AgentStatus | undefined, src = {}) =>
    buildSessionList([ws('p1', 'One', [node('a')])], null, 'p1', status ? { a: status } : {}, '', undefined, src)[0].sessions[0].view

  it('turn ended is calm Idle, a failure is Error, blocked needs you', () => {
    expect(one('waiting')).toMatchObject({ bucket: 'idle', label: 'Turn ended', icon: null })
    expect(one('failed').bucket).toBe('error')
    expect(one('blocked').bucket).toBe('needs-input')
  })

  it('no status and no exit is Idle "Ready" (never "No status"); an exit fact makes it Exited', () => {
    expect(one(undefined)).toMatchObject({ bucket: 'idle', label: 'Ready' })
    expect(one(undefined, { facts: { a: { live: false, exit: { code: 0, reason: 'self', at: 1 } } } }).bucket).toBe('exited')
  })

  it('carries the reason (live channel first, else the fetched one for the same status) and since', () => {
    expect(one('blocked', { reasons: { a: { reason: 'permission', detail: 'Bash' } } }).label).toBe('Waiting for approval: Bash')
    expect(one('blocked', { facts: { a: { live: true, status: 'blocked', reason: 'permission', detail: 'Edit', statusSince: 42 } } }))
      .toMatchObject({ label: 'Waiting for approval: Edit', since: 42 })
    // A fetched reason of an older status does not leak onto the new one.
    expect(one('working', { facts: { a: { live: true, status: 'blocked', reason: 'permission', detail: 'Edit' } } }).label).toBe('Working')
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
  it('prefixes the node name, and treats a legacy generated <adjective>-<noun> title as absent', () => {
    expect(sessionLabel(node('f', { name: 'Mango', title: 'Deploy' }))).toBe('Mango · Deploy')
    expect(sessionLabel(node('g', { name: 'Otter', kind: 'agent', agentId: 'claude', title: 'brisk-otter' }))).toBe('Otter · Claude Code')
    expect(sessionLabel(node('h', { kind: 'agent', agentId: 'claude', title: 'brisk-otter-2' }))).toBe('Claude Code')
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

describe('signalCounts', () => {
  it('counts needs-input and working, not turn ended / done / failed', () => {
    const rows = buildStatusList(
      [ws('p1', 'One', [node('a'), node('b'), node('c'), node('d')])],
      null,
      'p1',
      { a: 'waiting', b: 'blocked', c: 'working', d: 'failed' },
      '',
    ).flatMap((s) => s.rows)
    expect(signalCounts(rows)).toEqual({ attention: 1, working: 1 })
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
    expect(buildSessionList(projects, null, 'p1', noStatus, '')[0].sessions[0].view.unread).toBe(false)
    expect(
      buildSessionList(projects, null, 'p1', noStatus, '', new Set(['a1']))[0].sessions[0].view.unread,
    ).toBe(true)
  })

  it('carries the node kind (kind icon) and its own title (what Rename edits)', () => {
    const rows = buildSessionList([ws('p', 'P', [node('c', { kind: 'agentChat', agentId: 'claude', name: 'Puffin' })])], null, 'p', noStatus, '')[0].sessions
    expect(rows[0]).toMatchObject({ kind: 'agentChat', title: 'Agent Chat', label: 'Puffin · Agent Chat' })
  })

  it('sessionIds lists every session once (live nodes for the open board)', () => {
    expect(sessionIds(projects, [node('a1'), node('a7')], 'p1')).toEqual(['a1', 'a7', 'b1'])
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

  // test-only: pick a bucket by name rather than position.
  const rowsOf = (sections: StatusSection[], bucket: StatusBucket): SessionRowVM[] =>
    sections.find((s) => s.bucket === bucket)?.rows ?? []

  it('fixed lifecycle order Needs input -> Working -> Idle -> Error -> Exited, empty buckets left out', () => {
    const p = [ws('p1', 'Alpha', [node('w'), node('n'), node('i'), node('e')])]
    const sections = buildStatusList(p, null, 'p1', { w: 'working', n: 'blocked', i: 'waiting', e: 'failed' }, '')
    expect(sections.map((s) => [s.bucket, s.label, s.rows.map((r) => r.id)])).toEqual([
      ['needs-input', 'Needs input', ['n']],
      ['working', 'Working', ['w']],
      ['idle', 'Idle', ['i']],
      ['error', 'Error', ['e']],
    ])
  })

  it('unread is a flag on Idle rows, listed first inside Idle, not a bucket of its own', () => {
    const sections = buildStatusList(projects, null, 'p1', { a1: 'working', a2: 'waiting', b1: 'waiting' }, '', new Set(['a1', 'b1']))
    expect(sections.map((s) => s.bucket)).toEqual(['working', 'idle'])
    // a1 is marked but its new turn runs -> Working; b1 marked and ended -> first in Idle.
    expect(rowsOf(sections, 'working').map((r) => r.id)).toEqual(['a1'])
    expect(rowsOf(sections, 'idle').map((r) => [r.id, r.view.unread])).toEqual([['b1', true], ['a2', false]])
  })

  it('no "No status": a session with nothing known is Idle', () => {
    const sections = buildStatusList(projects, null, 'p1', noStatus, '')
    expect(sections.map((s) => [s.bucket, s.rows.length])).toEqual([['idle', 3]])
  })

  it('returns nothing when the filter matches nothing', () => {
    expect(buildStatusList(projects, null, 'p1', noStatus, 'zzz')).toEqual([])
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
    const rows = rowsOf(buildStatusList(projects, live, 'p2', noStatus, ''), 'idle')
    expect(rows.filter((r) => r.id === 'a1')).toHaveLength(1)
  })

  it('membawa nama workspace di setiap baris', () => {
    const rows = rowsOf(buildStatusList(projects, null, 'p1', noStatus, ''), 'idle')
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
    expect(sidebarEmptyState(true, '', true)).toBe('loading')
  })
})
