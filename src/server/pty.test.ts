import { describe, it, expect } from 'vitest'
import { descendantPids } from './pty'

// Snapshot `ps -Ao pid=,ppid=` tiruan: 100 = server, 200 = shell PTY node, 300/400 = cucu yang
// lolos dari SIGHUP, 999 = proses asing yang tidak boleh ikut tersapu.
const PS = `
    1     0
  100     1
  200   100
  300   200
  400   300
  999     1
`

describe('descendantPids', () => {
  it('mengumpulkan cucu dan cicit, bukan proses asing', () => {
    expect(descendantPids(200, PS)).toEqual([300, 400])
  })

  it('tidak pernah menyertakan pid itu sendiri atau leluhurnya (server tak boleh tersinyal)', () => {
    const found = descendantPids(200, PS)
    expect(found).not.toContain(200)
    expect(found).not.toContain(100)
    expect(found).not.toContain(1)
  })

  it('kosong untuk proses tanpa anak', () => {
    expect(descendantPids(400, PS)).toEqual([])
    expect(descendantPids(4242, PS)).toEqual([])
  })

  it('mengabaikan baris yang tidak berisi dua angka', () => {
    expect(descendantPids(200, 'PID PPID\n  300   200\n\ngarbage\n')).toEqual([300])
  })

  it('berhenti pada snapshot bersiklus, tidak menggantung', () => {
    // `ps` nyata tak pernah bersiklus; ini menjaga penelusuran tetap terbatas kalau sebuah baris
    // terbaca salah karena pid daur ulang.
    expect(descendantPids(200, '300 200\n200 300\n')).toEqual([300])
  })
})
