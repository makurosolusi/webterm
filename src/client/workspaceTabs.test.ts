import { describe, expect, it } from 'vitest'
import { workspaceTabDot, workspaceTabTitle } from './workspaceTabs'
import type { SessionGroup, SessionRowVM, StatusKind } from './sessionList'

// test-only: pabrik ringkas, hanya field yang dibaca `workspaceTabs`.
const row = (id: string, statusKind: StatusKind): SessionRowVM => ({
  id,
  label: id,
  isAgent: true,
  statusKind,
  stateLabel: statusKind,
  projectId: 'p',
  projectName: 'proj',
})

const group = (isActive: boolean, sessions: SessionRowVM[], name = 'makuro-agent'): SessionGroup => ({
  projectId: 'p',
  projectName: name,
  isActive,
  sessions,
})

describe('workspaceTabDot', () => {
  it('menaikkan attention di atas working pada workspace aktif', () => {
    expect(workspaceTabDot(group(true, [row('a', 'working'), row('b', 'attention')]))).toBe('attention')
  })

  it('memakai working ketika tidak ada yang menuntut perhatian', () => {
    expect(workspaceTabDot(group(true, [row('a', 'done'), row('b', 'working')]))).toBe('working')
  })

  it('menandai workspace aktif yang punya sesi tapi semuanya diam sebagai idle', () => {
    expect(workspaceTabDot(group(true, [row('a', 'done'), row('b', 'unknown')]))).toBe('idle')
  })

  it('netral ketika workspace aktif belum punya sesi sama sekali', () => {
    expect(workspaceTabDot(group(true, []))).toBe('neutral')
  })

  it('netral untuk workspace NON-AKTIF walau barisnya membawa status', () => {
    // Pagar atas jebakan sumber data: status node workspace lain tidak pernah sampai ke client,
    // jadi dot mereka tidak boleh pernah berwarna — bahkan bila peta status kebetulan terisi.
    expect(workspaceTabDot(group(false, [row('a', 'attention'), row('b', 'working')]))).toBe('neutral')
  })
})

describe('workspaceTabTitle', () => {
  it('merinci attention dan working pada workspace aktif', () => {
    expect(workspaceTabTitle(group(true, [row('a', 'attention'), row('b', 'working'), row('c', 'done')])))
      .toBe('makuro-agent — 3 sessions, 1 waiting for you, 1 running')
  })

  it('menjamak jumlah sesi dengan benar dan diam soal rincian yang nol', () => {
    expect(workspaceTabTitle(group(true, [row('a', 'done')]))).toBe('makuro-agent — 1 session')
  })

  it('mengatakan KENAPA workspace non-aktif tidak punya status', () => {
    expect(workspaceTabTitle(group(false, [row('a', 'working'), row('b', 'done')])))
      .toBe('makuro-agent — 2 sessions; status is live only for the open workspace')
  })
})
