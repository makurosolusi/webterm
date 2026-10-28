import { afterEach, describe, expect, it, vi } from 'vitest'

/** Modul `./unread` memegang state tingkat-modul (himpunan unread + node yang ditonton), jadi
 *  setiap kasus memuatnya segar alih-alih memaksa modul produksi mengekspor `reset()` test-only. */
function fresh() {
  vi.resetModules()
  return import('./unread')
}

/** Jendela browser palsu. `document` absen di node-env, dan `isWatching` membacanya langsung —
 *  jadi fokus jendela hanya bisa diuji dengan menyuntikkannya. */
function setWindowFocus(focused: boolean) {
  ;(globalThis as { document?: unknown }).document = { hasFocus: () => focused }
}

afterEach(() => {
  delete (globalThis as { document?: unknown }).document
})

describe('markUnread / clearUnread', () => {
  it('idempoten: tanda kedua tidak memancarkan event lagi', async () => {
    const { markUnread, subscribeUnread, unreadIds } = await fresh()
    const seen: number[] = []
    subscribeUnread((ids) => seen.push(ids.size))
    markUnread('n1')
    markUnread('n1')
    expect(seen).toEqual([1])
    expect([...unreadIds()]).toEqual(['n1'])
  })

  it('clear pada node yang tak pernah ditandai adalah no-op senyap', async () => {
    const { clearUnread, markUnread, subscribeUnread, unreadIds } = await fresh()
    const seen: number[] = []
    subscribeUnread((ids) => seen.push(ids.size))
    clearUnread('ghost')
    markUnread('n1')
    clearUnread('n1')
    clearUnread('n1')
    expect(seen).toEqual([1, 0])
    expect(unreadIds().size).toBe(0)
  })

  it('memancarkan snapshot baru, bukan himpunan yang sama dimutasi', async () => {
    // State React hanya render ulang pada identitas baru; snapshot bersama akan membuat
    // section Unread berhenti ter-update.
    const { markUnread, subscribeUnread } = await fresh()
    const snaps: ReadonlySet<string>[] = []
    subscribeUnread((ids) => snaps.push(ids))
    markUnread('n1')
    markUnread('n2')
    expect(snaps[0]).not.toBe(snaps[1])
    expect([...snaps[0]]).toEqual(['n1'])
    expect([...snaps[1]]).toEqual(['n1', 'n2'])
  })

  it('melepas subscriber yang unsubscribe', async () => {
    const { markUnread, subscribeUnread } = await fresh()
    let hits = 0
    const off = subscribeUnread(() => hits++)
    markUnread('n1')
    off()
    markUnread('n2')
    expect(hits).toBe(1)
  })
})

describe('noteStatus (aturan SET)', () => {
  it('menandai turn yang berakhir di node yang tidak ditonton', async () => {
    const { noteStatus, unreadIds } = await fresh()
    noteStatus('n1', 'done')
    noteStatus('n2', 'waiting')
    noteStatus('n3', 'blocked')
    expect([...unreadIds()].sort()).toEqual(['n1', 'n2', 'n3'])
  })

  it('tidak pernah menandai turn yang sedang jalan', async () => {
    const { noteStatus, unreadIds } = await fresh()
    noteStatus('n1', 'working')
    expect(unreadIds().size).toBe(0)
  })

  it('tidak menandai node yang sedang ditonton selagi jendela fokus', async () => {
    const { noteStatus, unreadIds, watchNode } = await fresh()
    setWindowFocus(true)
    watchNode('n1')
    noteStatus('n1', 'done')
    expect(unreadIds().size).toBe(0)
    // Node LAIN yang selesai di saat yang sama tetap ditandai — gerbangnya per node.
    noteStatus('n2', 'done')
    expect([...unreadIds()]).toEqual(['n2'])
  })

  it('menandai node yang ditonton bila jendelanya tidak fokus', async () => {
    const { noteStatus, unreadIds, watchNode } = await fresh()
    setWindowFocus(false)
    watchNode('n1')
    noteStatus('n1', 'done')
    expect([...unreadIds()]).toEqual(['n1'])
  })
})

describe('watchNode / unwatchNode (aturan CLEAR)', () => {
  it('membuka node membacanya', async () => {
    const { markUnread, unreadIds, watchNode } = await fresh()
    markUnread('n1')
    watchNode('n1')
    expect(unreadIds().size).toBe(0)
  })

  it('pindah ke node lain membuat node sebelumnya bisa ditandai lagi', async () => {
    const { noteStatus, unreadIds, watchNode } = await fresh()
    setWindowFocus(true)
    watchNode('n1')
    watchNode('n2')
    noteStatus('n1', 'done')
    expect([...unreadIds()]).toEqual(['n1'])
  })

  it('unwatch node lain tidak membatalkan watch yang sedang berlaku', async () => {
    // Dua node bertukar seleksi mengirim watchNode(B) lalu unwatchNode(A) dalam satu commit
    // React; tanpa jaga identitas, A akan melepas tontonan B dan turn B jadi salah ditandai.
    const { noteStatus, unreadIds, unwatchNode, watchNode } = await fresh()
    setWindowFocus(true)
    watchNode('b')
    unwatchNode('a')
    noteStatus('b', 'done')
    expect(unreadIds().size).toBe(0)
  })

  it('unwatch node yang sedang ditonton mengembalikan penandaan', async () => {
    const { noteStatus, unreadIds, unwatchNode, watchNode } = await fresh()
    setWindowFocus(true)
    watchNode('n1')
    unwatchNode('n1')
    noteStatus('n1', 'done')
    expect([...unreadIds()]).toEqual(['n1'])
  })
})
