import { describe, expect, it } from 'vitest'
import { bootWorkspaceId, deleteWorkspaceMessage, nextActiveWorkspaceId, normalizeWorkspaceName } from './workspaceMenu'

describe('normalizeWorkspaceName', () => {
  it('membuang spasi pinggir', () => {
    expect(normalizeWorkspaceName('  makuro  ')).toBe('makuro')
  })

  it('menolak nama kosong dan spasi-doang', () => {
    // Server akan menyimpannya dengan senang hati dan tab-nya jadi tanpa label.
    expect(normalizeWorkspaceName('')).toBeNull()
    expect(normalizeWorkspaceName('   \t ')).toBeNull()
  })

  it('tidak mengarang apa pun untuk nama yang sudah benar', () => {
    expect(normalizeWorkspaceName('web channel')).toBe('web channel')
  })
})

describe('nextActiveWorkspaceId', () => {
  const ids = ['a', 'b', 'c']

  it('menyerahkan slot ke tetangga KANAN ketika yang dihapus workspace aktif', () => {
    expect(nextActiveWorkspaceId(ids, 'b', 'b')).toBe('c')
  })

  it('jatuh ke tetangga KIRI ketika yang dihapus tab terakhir dan aktif', () => {
    expect(nextActiveWorkspaceId(ids, 'c', 'c')).toBe('b')
  })

  it('TIDAK memindahkan fokus ketika yang dihapus bukan workspace aktif', () => {
    expect(nextActiveWorkspaceId(ids, 'c', 'a')).toBe('a')
    expect(nextActiveWorkspaceId(ids, 'a', 'b')).toBe('b')
  })

  it('null ketika workspace terakhir dihapus — App harus mendarat di Welcome', () => {
    // Bukan string kosong: `PUT /api/active` menolak id kosong dengan 400, jadi pemanggil wajib
    // bisa membedakan "pindah ke sini" dari "tidak ada yang bisa diaktifkan".
    expect(nextActiveWorkspaceId(['a'], 'a', 'a')).toBeNull()
  })

  it('tetap null kalau tak ada workspace aktif sama sekali', () => {
    expect(nextActiveWorkspaceId(['a'], 'a', null)).toBeNull()
  })

  it('memilih tab pertama ketika id yang dihapus tidak ada di daftar', () => {
    expect(nextActiveWorkspaceId(ids, 'zz', 'zz')).toBe('a')
  })
})

describe('bootWorkspaceId', () => {
  const ids = ['a', 'b', 'c']

  it('memakai pointer aktif selama row-nya masih ada', () => {
    expect(bootWorkspaceId(ids, 'b')).toBe('b')
  })

  it('jatuh ke tab pertama kalau pointer menunjuk row yang sudah dihapus', () => {
    // Ini keadaan nyata, bukan karangan: pointer tidak bisa dikosongkan saat workspace terakhir
    // dihapus, jadi `GET /api/workspaces/<mati>` akan 404 kalau id itu dipakai apa adanya.
    expect(bootWorkspaceId(ids, 'zz')).toBe('a')
  })

  it('jatuh ke tab pertama kalau belum ada pointer sama sekali', () => {
    expect(bootWorkspaceId(ids, null)).toBe('a')
  })

  it('null untuk daftar kosong — termasuk saat pointer masih menyisa', () => {
    expect(bootWorkspaceId([], null)).toBeNull()
    expect(bootWorkspaceId([], 'zz')).toBeNull()
  })
})

describe('deleteWorkspaceMessage', () => {
  it('menyebut nama, jumlah sesi, dan apa yang TIDAK terhapus', () => {
    expect(deleteWorkspaceMessage('makuro', 2)).toBe(
      'Delete “makuro”? This ends its 2 sessions and removes the workspace from webterm, ' +
        'together with its saved board. The folder on disk is not deleted.',
    )
  })

  it('menjamak satu sesi dengan benar', () => {
    expect(deleteWorkspaceMessage('solo', 1)).toContain('ends its 1 session and')
  })

  it('diam soal sesi ketika workspace-nya kosong', () => {
    expect(deleteWorkspaceMessage('kosong', 0)).toBe(
      'Delete “kosong”? This removes the workspace from webterm, together with its saved board. ' +
        'The folder on disk is not deleted.',
    )
  })
})
