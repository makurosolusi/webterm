// Model pohon pane: split, tutup, kempis, kumpulkan daun, rasio.
//
// Semua di node-env, tanpa DOM: keputusan BENTUK pohon adalah bagian yang bisa salah tanpa
// terlihat di layar (pane yang hilang tapi PTY-nya hidup, cabang kempis yang tidak mengambil
// kembali ruangnya), jadi di sinilah bukti terkuatnya.
import { describe, expect, it } from 'vitest'
import {
  MIN_RATIO,
  boxRect,
  closeLeaf,
  isLeaf,
  leafIds,
  nextPaneId,
  paneLayout,
  paneSessionIds,
  ratioFromPointer,
  rootPane,
  sessionIdsOf,
  setRatio,
  splitLeaf,
} from './paneTree'
import type { Pane, PaneSplit } from '../shared/workspace'

const RECT = { left: 100, top: 50, width: 400, height: 200 }

/** Pohon 2×2 PERSIS seperti screenshot keluhan: satu split berdampingan, lalu kedua sisinya
 *  masing-masing dibelah bertumpuk. Dibangun lewat `splitLeaf` saja — kalau `splitLeaf` salah,
 *  fixture-nya ikut salah dan assertion bentuknya di bawah yang menangkapnya. */
function quad(): Pane {
  let t: Pane = { id: 'n1' }
  t = splitLeaf(t, 'n1', 'h', 'n1:p2')
  t = splitLeaf(t, 'n1', 'v', 'n1:p3')
  t = splitLeaf(t, 'n1:p2', 'v', 'n1:p4')
  return t
}

describe('pohon pane', () => {
  it('node tanpa panes adalah satu daun ber-id NODE, jadi board lama tak kehilangan shell-nya', () => {
    expect(rootPane('n1', undefined)).toEqual({ id: 'n1' })
    expect(leafIds(rootPane('n1', undefined))).toEqual(['n1'])
    // Pohon yang sudah ada dipakai apa adanya, bukan dibungkus lagi.
    const t: Pane = { dir: 'h', ratio: 0.5, a: { id: 'n1' }, b: { id: 'n1:p2' } }
    expect(rootPane('n1', t)).toBe(t)
  })

  it('split pertama menaruh daun lama di `a` dan pane baru di `b`, setengah-setengah', () => {
    const t = splitLeaf({ id: 'n1' }, 'n1', 'h', 'n1:p2')
    expect(isLeaf(t)).toBe(false)
    expect(t).toEqual({ dir: 'h', ratio: 0.5, a: { id: 'n1' }, b: { id: 'n1:p2' } })
  })

  it('membelah daun BERSARANG menyusun 2×2 seperti screenshot, bukan daftar datar', () => {
    const t = quad() as PaneSplit

    // Bentuk persisnya, bukan cuma jumlah daun: daftar datar berisi empat id juga lulus "ada 4".
    expect(t.dir).toBe('h')
    expect(isLeaf(t.a)).toBe(false)
    expect(isLeaf(t.b)).toBe(false)
    expect(t).toEqual({
      dir: 'h',
      ratio: 0.5,
      a: { dir: 'v', ratio: 0.5, a: { id: 'n1' }, b: { id: 'n1:p3' } },
      b: { dir: 'v', ratio: 0.5, a: { id: 'n1:p2' }, b: { id: 'n1:p4' } },
    })
    expect(leafIds(t)).toEqual(['n1', 'n1:p3', 'n1:p2', 'n1:p4'])
  })

  it('membelah daun yang tidak ada memulangkan pohon yang SAMA (sinyal "tak ada yang terbelah")', () => {
    const t = quad()
    expect(splitLeaf(t, 'bukan-daun', 'h', 'x')).toBe(t)
  })

  it('id pane baru tidak pernah menabrak id yang sudah dipakai', () => {
    const t = quad()
    const fresh = nextPaneId(t, 'n1')
    expect(leafIds(t)).not.toContain(fresh)
    // Daun yang ditutup di tengah membuat nomornya berlubang; id berikutnya tetap harus bebas.
    const holed = closeLeaf(t, 'n1:p3')!
    expect(leafIds(holed)).not.toContain(nextPaneId(holed, 'n1'))
  })

  it('menutup satu daun MENGEMPISKAN cabangnya: sisanya menggantikan cabang itu', () => {
    const t = quad()
    const next = closeLeaf(t, 'n1:p3')!
    // Cabang kiri tinggal satu anak, jadi ia DIGANTI anak itu — bukan cabang dengan sisi kosong.
    expect(next).toEqual({
      dir: 'h',
      ratio: 0.5,
      a: { id: 'n1' },
      b: { dir: 'v', ratio: 0.5, a: { id: 'n1:p2' }, b: { id: 'n1:p4' } },
    })
    expect(leafIds(next)).toEqual(['n1', 'n1:p2', 'n1:p4'])
  })

  it('menutup daun terakhir memulangkan null — tidak ada lagi yang bisa ditampilkan', () => {
    expect(closeLeaf({ id: 'n1' }, 'n1')).toBeNull()
    const two = splitLeaf({ id: 'n1' }, 'n1', 'h', 'n1:p2')
    // Daun AKAR boleh ditutup: yang bertahan adalah pane turunan, dan node tetap hidup.
    expect(closeLeaf(two, 'n1')).toEqual({ id: 'n1:p2' })
    expect(closeLeaf(closeLeaf(two, 'n1')!, 'n1:p2')).toBeNull()
  })

  it('menutup daun yang tidak ada tidak mengubah apa pun', () => {
    const t = quad()
    expect(closeLeaf(t, 'bukan-daun')).toBe(t)
  })

  it('rasio ditulis ke cabang yang dialamatkan, bukan ke akar', () => {
    const t = quad()
    const root = setRatio(t, '', 0.3) as PaneSplit
    expect(root.ratio).toBe(0.3)
    expect((root.a as PaneSplit).ratio).toBe(0.5)

    const kiri = setRatio(t, 'a', 0.25) as PaneSplit
    expect(kiri.ratio).toBe(0.5)
    expect((kiri.a as PaneSplit).ratio).toBe(0.25)
    expect((kiri.b as PaneSplit).ratio).toBe(0.5)

    const kanan = setRatio(t, 'b', 0.75) as PaneSplit
    expect((kanan.a as PaneSplit).ratio).toBe(0.5)
    expect((kanan.b as PaneSplit).ratio).toBe(0.75)
  })

  it('rasio dijepit di kedua ujung — pane yang bisa mengecil ke nol hilang tapi PTY-nya hidup', () => {
    expect((setRatio({ dir: 'h', ratio: 0.5, a: { id: 'a' }, b: { id: 'b' } }, '', -5) as PaneSplit).ratio)
      .toBe(MIN_RATIO)
    expect((setRatio({ dir: 'h', ratio: 0.5, a: { id: 'a' }, b: { id: 'b' } }, '', 9) as PaneSplit).ratio)
      .toBe(1 - MIN_RATIO)
  })

  it('rasio dari pointer dihitung pada sumbu yang sesuai arah split', () => {
    // 'h' membaca X: 300 di dalam rect yang mulai di 100 dan lebar 400 → seperempat.
    expect(ratioFromPointer(RECT, { x: 200, y: 999 }, 'h')).toBeCloseTo(0.25)
    // 'v' membaca Y: 150 di dalam rect yang mulai di 50 dan tinggi 200 → setengah.
    expect(ratioFromPointer(RECT, { x: 999, y: 150 }, 'v')).toBeCloseTo(0.5)
    // Sumbunya benar-benar berbeda, jadi arah yang tertukar tidak bisa lolos diam-diam.
    expect(ratioFromPointer(RECT, { x: 200, y: 150 }, 'h'))
      .not.toBeCloseTo(ratioFromPointer(RECT, { x: 200, y: 150 }, 'v'))
  })

  it('rasio dari pointer dijepit, dan span nol tidak pernah jadi NaN yang ikut dipersist', () => {
    expect(ratioFromPointer(RECT, { x: -1000, y: 0 }, 'h')).toBe(MIN_RATIO)
    expect(ratioFromPointer(RECT, { x: 1000, y: 0 }, 'h')).toBe(1 - MIN_RATIO)
    const kosong = { left: 0, top: 0, width: 0, height: 0 }
    expect(ratioFromPointer(kosong, { x: 5, y: 5 }, 'h')).toBe(0.5)
    expect(ratioFromPointer(kosong, { x: 5, y: 5 }, 'v')).toBe(0.5)
  })
})

describe('layout pane', () => {
  it('daun tunggal menempati seluruh badan node, tanpa pembatas', () => {
    expect(paneLayout({ id: 'n1' })).toEqual({
      panes: [{ id: 'n1', left: 0, top: 0, width: 100, height: 100 }],
      dividers: [],
    })
  })

  it("split 'h' membagi LEBAR dan menaruh pembatas tegak di batasnya", () => {
    const { panes, dividers } = paneLayout({ dir: 'h', ratio: 0.5, a: { id: 'a' }, b: { id: 'b' } })
    expect(panes).toEqual([
      { id: 'a', left: 0, top: 0, width: 50, height: 100 },
      { id: 'b', left: 50, top: 0, width: 50, height: 100 },
    ])
    expect(dividers).toEqual([
      { path: '', dir: 'h', at: 50, box: { left: 0, top: 0, width: 100, height: 100 } },
    ])
  })

  it("split 'v' membagi TINGGI — sumbunya benar-benar berbeda dari 'h'", () => {
    const { panes } = paneLayout({ dir: 'v', ratio: 0.25, a: { id: 'a' }, b: { id: 'b' } })
    expect(panes).toEqual([
      { id: 'a', left: 0, top: 0, width: 100, height: 25 },
      { id: 'b', left: 0, top: 25, width: 100, height: 75 },
    ])
  })

  it('2×2 menghasilkan empat kuadran yang tidak saling menimpa', () => {
    const { panes, dividers } = paneLayout(quad())
    expect(panes).toEqual([
      { id: 'n1', left: 0, top: 0, width: 50, height: 50 },
      { id: 'n1:p3', left: 0, top: 50, width: 50, height: 50 },
      { id: 'n1:p2', left: 50, top: 0, width: 50, height: 50 },
      { id: 'n1:p4', left: 50, top: 50, width: 50, height: 50 },
    ])
    // Tiga pembatas: satu tegak di tengah, lalu satu datar DI MASING-MASING kolom — dan yang di
    // kolom kanan direntangkan pada kotak kolom itu, bukan pada seluruh node.
    expect(dividers).toEqual([
      { path: '', dir: 'h', at: 50, box: { left: 0, top: 0, width: 100, height: 100 } },
      { path: 'a', dir: 'v', at: 50, box: { left: 0, top: 0, width: 50, height: 100 } },
      { path: 'b', dir: 'v', at: 50, box: { left: 50, top: 0, width: 50, height: 100 } },
    ])
  })

  it('persennya bersih, bukan 30.000000000000004 yang ikut masuk ke style CSS', () => {
    const { panes } = paneLayout({ dir: 'h', ratio: 0.3, a: { id: 'a' }, b: { id: 'b' } })
    expect(panes[0].width).toBe(30)
    expect(panes[1].left).toBe(30)
    // Dan tetap menutup penuh: lebar tak boleh menguap jadi 69.99999999999999.
    expect(panes[1].width).toBe(70)
  })

  it('tiap pane dapat path cabang yang bisa dialamatkan `setRatio`', () => {
    // Pembatas memberi path cabangnya; dipakai apa adanya untuk menulis rasio cabang ITU.
    const { dividers } = paneLayout(quad())
    const next = setRatio(quad(), dividers[2].path, 0.8)
    const { panes } = paneLayout(next)
    // Hanya kolom kanan yang bergerak.
    expect(panes.map((p) => `${p.id}@${p.top}`)).toEqual([
      'n1@0', 'n1:p3@50', 'n1:p2@0', 'n1:p4@80',
    ])
  })
})

describe('kotak persen ke rect piksel', () => {
  const HOST = { left: 100, top: 50, width: 400, height: 200 }

  it('seluruh kotak = rect host apa adanya', () => {
    expect(boxRect(HOST, { left: 0, top: 0, width: 100, height: 100 })).toEqual(HOST)
  })

  it('kotak cabang diterjemahkan ke piksel, jadi geser pembatas memakai rentang yang benar', () => {
    // Kolom kanan sebuah split 'h' 50/50.
    expect(boxRect(HOST, { left: 50, top: 0, width: 50, height: 100 }))
      .toEqual({ left: 300, top: 50, width: 200, height: 200 })
    // Dan rasio dari pointer dihitung pada rentang itu: x=400 adalah TENGAH kolom kanan,
    // sementara terhadap seluruh node ia tiga perempat.
    const branch = boxRect(HOST, { left: 50, top: 0, width: 50, height: 100 })
    expect(ratioFromPointer(branch, { x: 400, y: 0 }, 'h')).toBeCloseTo(0.5)
    expect(ratioFromPointer(HOST, { x: 400, y: 0 }, 'h')).toBeCloseTo(0.75)
  })
})

describe('id sesi yang harus ditutup', () => {
  it('node tanpa panes menutup satu id — persis perilaku sebelum split ada', () => {
    expect(sessionIdsOf(undefined, 'n1')).toEqual(['n1'])
    expect(paneSessionIds([{ id: 'n1', data: {} }], ['n1'])).toEqual(['n1'])
  })

  it('node 2×2 menutup KEEMPAT PTY-nya, bukan cuma id node', () => {
    const nodes = [{ id: 'n1', data: { panes: quad() } }, { id: 'n2', data: {} }]
    expect(paneSessionIds(nodes, ['n1'])).toEqual(['n1', 'n1:p3', 'n1:p2', 'n1:p4'])
    // Jumlahnya yang menentukan: inilah shell yang dulu bocor hidup sampai server restart.
    expect(paneSessionIds(nodes, ['n1'])).toHaveLength(4)
  })

  it('beberapa node sekaligus (select-all lalu delete) menutup semua daun semuanya', () => {
    const nodes = [
      { id: 'n1', data: { panes: splitLeaf({ id: 'n1' }, 'n1', 'h', 'n1:p2') } },
      { id: 'n2', data: {} },
    ]
    expect(paneSessionIds(nodes, ['n1', 'n2'])).toEqual(['n1', 'n1:p2', 'n2'])
  })

  it('id yang node-nya sudah lepas dari daftar TETAP ditutup', () => {
    // Menyaringnya di sini akan membatalkan penutupan sesi yang memang harus mati.
    expect(paneSessionIds([], ['hilang'])).toEqual(['hilang'])
  })
})
