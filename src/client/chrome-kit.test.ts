import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { contextFillColor, USAGE_RED, USAGE_YELLOW, USAGE_GREEN } from './UsagePill'
import { NODE_COLORS } from './NodeColorSwatch'
import { statusChip, termNodeClass, UNTITLED } from './NodeChrome'

describe('contextFillColor', () => {
  it('> 85 → red', () => { expect(contextFillColor(90)).toBe(USAGE_RED) })
  it('86 is red (strictly greater than 85)', () => { expect(contextFillColor(86)).toBe(USAGE_RED) })
  it('85 is NOT red → yellow (>=60 band)', () => { expect(contextFillColor(85)).toBe(USAGE_YELLOW) })
  it('60 boundary → yellow', () => { expect(contextFillColor(60)).toBe(USAGE_YELLOW) })
  it('59 → green', () => { expect(contextFillColor(59)).toBe(USAGE_GREEN) })
  it('0 → green', () => { expect(contextFillColor(0)).toBe(USAGE_GREEN) })
})
// -----------------------------------------------------------------------------------------------
// Gejala yang dilaporkan: node agent memasang chip NEEDS YOU, pengguna membaca percakapannya dan
// tidak menemukan permintaan konfirmasi apa pun — agent-nya cuma menyelesaikan turn. Chip yang
// berteriak palsu berhenti dipercaya.
//
// Akar: BUKAN di server. `hookStatus` sudah membedakan `blocked` (mandeg menunggu izin) dari
// `waiting` (turn habis); peta label di `statusChip` yang menggabungkan keduanya kembali.
//
// Bentuk LAMA dibawa sebagai konstanta supaya terbukti test ini menggigit — bukan hijau karena
// polanya mustahil ditemukan.
const OLD_CHIP: Record<'waiting' | 'blocked', { cls: string; label: string }> = {
  waiting: { cls: 'node-status--attention', label: 'NEEDS YOU' },
  blocked: { cls: 'node-status--attention', label: 'NEEDS YOU' },
}

describe('statusChip', () => {
  it('working → RUNNING, diwarnai state working', () => {
    expect(statusChip('working')).toEqual({ cls: 'node-status--busy', label: 'RUNNING', title: 'Agent is working' })
  })

  it('blocked tetap pemegang penanda terkuat: NEEDS YOU', () => {
    // Hanya `blocked` yang berarti kerja MANDEG sampai pengguna bertindak, jadi ia yang mewarisi
    // chip paling keras — kata, warna, dan denyut dot.
    expect(statusChip('blocked')).toEqual({
      cls: 'node-status--attention',
      label: 'NEEDS YOU',
      title: 'Blocked — waiting for your approval',
    })
  })

  it('waiting TIDAK lagi meminjam chip blocked — beda kata DAN beda kelas warna', () => {
    const waiting = statusChip('waiting')
    const blocked = statusChip('blocked')
    expect(waiting?.label).not.toBe(OLD_CHIP.waiting.label)
    expect(waiting?.cls).not.toBe(OLD_CHIP.waiting.cls)
    // Dua sumbu, bukan satu: label yang beda tapi warna sama tidak bisa dibedakan dalam sekejap
    // pada chip sebesar itu.
    expect(waiting?.label).not.toBe(blocked?.label)
    expect(waiting?.cls).not.toBe(blocked?.cls)
    // Dan ia tidak boleh ikut menuntut tindakan dalam kalimatnya.
    expect(waiting?.title).not.toBe(blocked?.title)
  })

  it('bentuk lama akan gagal guard ini', () => {
    // Bukti arah: kalau peta lama dipasang kembali, dua status itu menghasilkan chip identik —
    // tepat gejala yang dilaporkan.
    expect(OLD_CHIP.waiting).toEqual(OLD_CHIP.blocked)
    expect({ cls: statusChip('waiting')?.cls, label: statusChip('waiting')?.label })
      .not.toEqual({ cls: statusChip('blocked')?.cls, label: statusChip('blocked')?.label })
  })

  it('tidak ada chip untuk done maupun status yang hilang (nodeterm tidak punya chip DONE)', () => {
    expect(statusChip('done')).toBeNull()
    expect(statusChip(undefined)).toBeNull()
  })
})

describe('termNodeClass', () => {
  it('node polos hanya .term-node', () => {
    expect(termNodeClass({})).toBe('term-node')
  })
  it('selected dan collapsed memakai modifier BEM yang sudah dipakai AgentNode', () => {
    expect(termNodeClass({ selected: true, collapsed: true }))
      .toBe('term-node term-node--selected term-node--collapsed')
  })
  it('working/attention TANPA prefiks — selector glow :has() nodeterm mencocokkan kelas polos', () => {
    expect(termNodeClass({ status: 'working' })).toBe('term-node working')
    expect(termNodeClass({ status: 'blocked' })).toBe('term-node attention')
  })
  it('waiting tidak lagi memakai halo merah berdenyut milik blocked', () => {
    // Halo node adalah penanda terkencang di canvas. Kalau turn yang cuma habis ikut memakainya,
    // chip amber di header dibatalkan oleh node yang mengelilinginya.
    expect(termNodeClass({ status: 'waiting' })).not.toBe('term-node attention')
    expect(termNodeClass({ status: 'waiting' })).toBe('term-node waiting')
  })
  it('done tidak menyalakan glow apa pun', () => {
    expect(termNodeClass({ status: 'done' })).toBe('term-node')
  })
  it('judul kosong jatuh ke fallback nodeterm', () => {
    expect(UNTITLED).toBe('Untitled')
  })
})

describe('NODE_COLORS', () => {
  it('is a non-empty palette of hex strings', () => {
    expect(NODE_COLORS.length).toBeGreaterThan(0)
    for (const c of NODE_COLORS) expect(c).toMatch(/^#[0-9a-f]{6}$/i)
  })
})

describe('node-chrome.css — chip waiting vs blocked benar-benar beda', () => {
  // `statusChip` hanya mengembalikan NAMA kelas; yang membuat dua chip itu beda dalam sekejap ada
  // di sheet-nya. Tanpa DOM di vitest (`getComputedStyle` tak ada) yang bisa diuji adalah BENTUK
  // sumbernya: kelas baru itu harus ADA, memakai token warna yang LAIN, dan tidak ikut berdenyut.
  const chrome = readFileSync(fileURLToPath(new URL('./node-chrome.css', import.meta.url)), 'utf8')
  const decl = (sel: string) => chrome.match(new RegExp(`\\${sel}\\s*\\{([^}]*)\\}`))?.[1] ?? ''

  it('dua kelas chip memakai dua token warna', () => {
    expect(decl('.node-status--attention')).toContain('var(--state-attention)')
    expect(decl('.node-status--waiting')).toContain('var(--state-warning)')
    expect(decl('.node-status--waiting')).not.toContain('var(--state-attention)')
  })

  it('hanya blocked yang dot-nya berdenyut', () => {
    expect(chrome).toContain('.node-status--attention .node-status-dot { animation:')
    expect(chrome).not.toContain('.node-status--waiting .node-status-dot { animation:')
  })

  it('kelas glow waiting ada dan tidak memakai halo pseudo merah', () => {
    // Kelas yang dikembalikan `termNodeClass` tapi tak pernah didefinisikan = node tanpa penanda.
    expect(decl('.term-node.waiting')).toContain('var(--state-warning)')
    expect(chrome).not.toContain(':has(.term-node.waiting)')
  })
})

describe('node-chrome.css — ongkos compositing', () => {
  // Seluruh sheet ini menata isi viewport React Flow, yang hidup di bawah `transform`. Satu
  // `will-change` di sini mempromosikan tiap node jadi compositing layer PERMANEN (bukan hanya
  // selama animasi), dan layer composited di dalam parent yang di-transform adalah penyebab kedip
  // repaint di Chromium. Animasi opacity tidak butuh hint itu — browser mempromosikannya sendiri
  // selagi berjalan. Jadi: nol `will-change` di sheet ini, glow status termasuk.
  it('tidak memakai will-change sama sekali', () => {
    const chrome = readFileSync(fileURLToPath(new URL('./node-chrome.css', import.meta.url)), 'utf8')
    expect(chrome).toContain('animation: nt-working-glow')
    expect(chrome).toContain('animation: nt-attention-glow')
    // Komentar dibuang dulu: yang dilarang itu DEKLARASI-nya, sedangkan komentar di sheet itu
    // memang menyebut `will-change` untuk menjelaskan kenapa ia tidak ada.
    expect(chrome.replace(/\/\*[\s\S]*?\*\//g, '')).not.toContain('will-change')
  })
})
