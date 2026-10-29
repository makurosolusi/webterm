import { describe, expect, it } from 'vitest'
import {
  CLOSED_HISTORY_CAP,
  closedEntriesFor,
  pushClosed,
  takeClosed,
  visibleClosed,
  type ClosedEntry,
} from './closedHistory'
import type { WsNode } from '../shared/workspace'

const node = (id: string, kind: WsNode['kind'] = 'terminal'): WsNode => ({ id, kind, x: 0, y: 0 })
const ws = { id: 'w1', name: 'makuro' }

const entry = (id: string, closedAt: number, workspaceId = 'w1'): ClosedEntry => ({
  node: node(id),
  workspaceId,
  workspaceName: 'makuro',
  closedAt,
})

describe('closedEntriesFor', () => {
  it('membawa snapshot node UTUH, bukan id — node-nya sudah tidak ada di tempat lain', () => {
    const agent: WsNode = { id: 'n1', kind: 'agent', x: 40, y: 80, agentId: 'claude', sessionId: 'abc', cwd: '/tmp' }
    const [e] = closedEntriesFor(['n1'], [agent], ws, 1000)
    expect(e.node).toEqual(agent)
    expect(e).toMatchObject({ workspaceId: 'w1', workspaceName: 'makuro', closedAt: 1000 })
  })

  it('hanya node sesi: files/editor bukan shell, jadi tidak masuk riwayat', () => {
    const nodes = [node('t', 'terminal'), node('a', 'agent'), node('f', 'files'), node('e', 'editor')]
    expect(closedEntriesFor(['t', 'a', 'f', 'e'], nodes, ws).map((x) => x.node.id)).toEqual(['t', 'a'])
  })

  it('melewati id yang tidak ada di daftar node', () => {
    expect(closedEntriesFor(['hantu'], [node('t')], ws)).toEqual([])
  })

  it('kosong tanpa workspace pemilik — entry seperti itu tidak bisa dipulihkan ke mana pun', () => {
    expect(closedEntriesFor(['t'], [node('t')], null)).toEqual([])
  })
})

describe('pushClosed', () => {
  it('terbaru di ATAS', () => {
    const list = pushClosed(pushClosed([], [entry('a', 1)]), [entry('b', 2)])
    expect(list.map((e) => e.node.id)).toEqual(['b', 'a'])
  })

  it(`memotong di ${CLOSED_HISTORY_CAP} dan yang dibuang adalah yang TERLAMA`, () => {
    let list: ClosedEntry[] = []
    for (let i = 0; i < CLOSED_HISTORY_CAP + 3; i++) list = pushClosed(list, [entry(`n${i}`, i)])
    expect(list).toHaveLength(CLOSED_HISTORY_CAP)
    expect(list[0].node.id).toBe('n12')
    expect(list.at(-1)?.node.id).toBe('n3')
    expect(list.some((e) => e.node.id === 'n0')).toBe(false)
  })

  it('dedup per node id, yang TERBARU yang bertahan', () => {
    const list = pushClosed([entry('a', 1), entry('b', 2)], [entry('a', 99)])
    expect(list.map((e) => e.node.id)).toEqual(['a', 'b'])
    expect(list[0].closedAt).toBe(99)
  })

  it('satu batch bisa membawa beberapa node sekaligus, urutannya terjaga', () => {
    expect(pushClosed([], [entry('a', 1), entry('b', 1)]).map((e) => e.node.id)).toEqual(['a', 'b'])
  })
})

describe('visibleClosed', () => {
  it('membuang entry yang workspace-nya sudah dihapus', () => {
    const list = [entry('a', 1, 'w1'), entry('b', 2, 'hilang')]
    expect(visibleClosed(list, ['w1']).map((e) => e.node.id)).toEqual(['a'])
  })

  it('membuang entry yang node-nya sudah kembali ke canvas (undo layout)', () => {
    // Barisnya akan bohong, dan mengkliknya menduplikasi id yang sudah hidup di React Flow.
    expect(visibleClosed([entry('a', 1)], ['w1'], ['a'])).toEqual([])
  })

  it('tanpa daftar node live, hanya workspace yang menyaring', () => {
    expect(visibleClosed([entry('a', 1)], ['w1'])).toHaveLength(1)
  })
})

describe('takeClosed', () => {
  it('mengembalikan entry yang diminta dan sisanya TANPA entry itu', () => {
    const { entry: got, rest } = takeClosed([entry('a', 1), entry('b', 2)], 'a')
    expect(got?.node.id).toBe('a')
    expect(rest.map((e) => e.node.id)).toEqual(['b'])
  })

  it('undefined untuk id yang tidak ada, daftar utuh', () => {
    const list = [entry('a', 1)]
    const { entry: got, rest } = takeClosed(list, 'zz')
    expect(got).toBeUndefined()
    expect(rest).toHaveLength(1)
  })

  it('tidak memutasi daftar asal — pemanggil mengandalkannya untuk membatalkan pengambilan', () => {
    const list = [entry('a', 1)]
    takeClosed(list, 'a')
    expect(list).toHaveLength(1)
  })
})
