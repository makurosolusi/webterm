import { describe, expect, it } from 'vitest'
import {
  canScrollStripBy,
  tabStripOverflow,
  workspaceTabDot,
  workspaceTabTitle,
  type TabOverflow,
} from './workspaceTabs'
import { scrollTopToReveal } from './filesKeys'
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

// Bentuk lama #1: tidak ada perhitungan sama sekali. Scrollbar strip disembunyikan dan tepinya
// terpotong rata, jadi berapa pun tab yang tersembunyi jawabannya selalu "tidak ada tanda".
const OLD_NO_OVERFLOW_HINT: TabOverflow = 'none'

/** Bentuk lama #2 (versi naif yang akan ditulis orang): perbandingan KETAT, tanpa toleransi
 *  sub-piksel. Lolos pada angka bulat, dan justru salah di display HiDPI/zoom halaman. */
const oldStrictOverflow = (scrollLeft: number, clientWidth: number, scrollWidth: number): TabOverflow => {
  const l = scrollLeft > 0
  const r = scrollLeft + clientWidth < scrollWidth
  return l && r ? 'both' : l ? 'left' : r ? 'right' : 'none'
}

/** Bentuk lama #3: roda ditelan tanpa syarat begitu handler-nya ada. */
const OLD_WHEEL_ALWAYS_SWALLOWS = true

describe('tabStripOverflow', () => {
  it('tidak menandai apa pun ketika seluruh deretan tab muat di bar', () => {
    expect(tabStripOverflow(0, 420, 420)).toBe('none')
  })

  it('menandai kanan saja di awal strip yang berlanjut', () => {
    expect(tabStripOverflow(0, 300, 900)).toBe('right')
  })

  it('menandai kiri saja setelah digulung habis ke kanan', () => {
    expect(tabStripOverflow(600, 300, 900)).toBe('left')
  })

  it('menandai kedua sisi di tengah strip', () => {
    expect(tabStripOverflow(300, 300, 900)).toBe('both')
  })

  it('mentoleransi beda sub-piksel di kedua ujung — pudar yang tak pernah hilang itu bohong', () => {
    // Gulungan maksimum di sini 421; `scrollLeft` fraksional menyisakan 0.4px yang tak terlihat.
    expect(tabStripOverflow(420.6, 300, 721)).toBe('left')
    expect(tabStripOverflow(0.4, 300, 900)).toBe('right')
  })

  it('kedua bentuk lama memberi jawaban yang BERBEDA', () => {
    // Tanpa perhitungan: tidak ada tanda, padahal 600px tab tersembunyi di kanan.
    expect(tabStripOverflow(0, 300, 900)).not.toBe(OLD_NO_OVERFLOW_HINT)
    // Perbandingan ketat: memudarkan kanan yang tab terakhirnya sudah tampak seluruhnya.
    expect(oldStrictOverflow(420.6, 300, 721)).toBe('both')
    expect(oldStrictOverflow(0.4, 300, 900)).toBe('both')
    // Dan ia tetap sepakat di angka bulat, supaya ini bukan guard yang selalu merah.
    expect(oldStrictOverflow(300, 300, 900)).toBe(tabStripOverflow(300, 300, 900))
  })
})

describe('canScrollStripBy', () => {
  it('menolak strip yang tidak menggulung sama sekali, ke arah mana pun', () => {
    expect(canScrollStripBy(0, 420, 420, 120)).toBe(false)
    expect(canScrollStripBy(0, 420, 420, -120)).toBe(false)
    // Inilah yang dilakukan bentuk lama pada ketiga baris di blok ini.
    expect(canScrollStripBy(0, 420, 420, 120)).not.toBe(OLD_WHEEL_ALWAYS_SWALLOWS)
  })

  it('menolak arah yang sudah habis tapi menerima arah yang masih punya ruang', () => {
    expect(canScrollStripBy(0, 300, 900, -120)).toBe(false)
    expect(canScrollStripBy(0, 300, 900, 120)).toBe(true)
    expect(canScrollStripBy(600, 300, 900, 120)).toBe(false)
    expect(canScrollStripBy(600, 300, 900, -120)).toBe(true)
  })

  it('menolak delta nol — tak ada yang perlu ditelan', () => {
    expect(canScrollStripBy(300, 300, 900, 0)).toBe(false)
  })
})

// Gap "tab aktif di luar layar" memakai ULANG `scrollTopToReveal` (filesKeys) pada sumbu X. Yang
// diperiksa di sini bukan fungsi orang lain, tapi bahwa pemakaian sumbu-X itu memang memberi
// perilaku "sedekat mungkin" yang dijanjikan `WorkspaceBar.revealActiveTab`.
describe('reveal tab aktif pada sumbu X', () => {
  const FADE = 24
  /** Persis ekspresi di `revealActiveTab`, dengan geometri tab sebagai masukan. */
  const reveal = (tabLeft: number, tabWidth: number, scrollLeft: number, viewWidth: number) =>
    scrollTopToReveal(tabLeft - FADE, tabWidth + FADE * 2, scrollLeft, viewWidth)

  it('TIDAK menggerakkan strip untuk tab yang sudah tampak seluruhnya di luar pita pudar', () => {
    expect(reveal(340, 120, 300, 600)).toBe(300)
  })

  it('menggulung sesedikit mungkin untuk tab di luar layar di kanan', () => {
    // Tepi kanan tab (1400) + pita pudar harus mendarat di tepi kanan pandangan.
    expect(reveal(1280, 120, 0, 600)).toBe(1400 + FADE - 600)
  })

  it('menggulung ke kiri untuk tab di belakang posisi gulung sekarang', () => {
    expect(reveal(80, 120, 400, 600)).toBe(80 - FADE)
  })

  it('tidak memaksa tab ke TENGAH pandangan — itu menggeser tab yang sudah tenang', () => {
    const centered = 340 + 120 / 2 - 600 / 2
    expect(reveal(340, 120, 300, 600)).not.toBe(centered)
  })
})
