import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Yang dijaga di sini adalah URUTAN di App.tsx + `workspaceLifecycle.ts` (yang memuat jalur commit
// board-nya), dan urutan hanya hidup di JSX/callback — vitest
// webterm jalan di node-env tanpa DOM, jadi tidak ada komponen yang bisa dirender untuk
// membuktikannya. Yang bisa dilakukan: membaca source-nya dan menolak bentuk yang salah, pola yang
// sama dengan `nodeRender.test.ts`.
const src = (f: string) => readFileSync(fileURLToPath(new URL(`./${f}`, import.meta.url)), 'utf8')

/** Potongan dari tiap `applyWorkspace(...)` sampai ujung callback-nya (`}, [deps])`). */
const tailsAfterApply = (s: string) =>
  s.split(/\bapplyWorkspace\(/).slice(1).map((t) => t.split(/\n *\}, \[/)[0])

/**
 * Board boleh di-commit hanya setelah semua request selesai. Satu `await` SETELAH commit berarti
 * React sudah merender canvas yang pindah sebelum datanya lengkap — `defaultViewport` React Flow
 * dibaca saat mount, jadi render pertama itu yang membuang viewport tersimpan.
 */
const appliesAfterLastAwait = (s: string) => tailsAfterApply(s).every((t) => !/\bawait\b/.test(t))

/** Dua state yang di-commit terpisah adalah mesin kedipnya; `activeId` wajib turunan. */
const hasSplitActiveState = (s: string) => /\bsetActiveId\b|\bloadWorkspace\b/.test(s)

// Bentuk lama, persis seperti sebelum urutannya dibetulkan. Dipakai untuk membuktikan guard di
// bawah benar-benar menggigit, bukan lulus karena polanya mustahil ditemukan.
const OLD_SELECT = `  const onSelect = useCallback(async (id: string) => {
    if (!id || id === activeId) return
    await setActive(id)
    setActiveId(id)
    await loadWorkspace(id)
  }, [activeId, loadWorkspace])`
const OLD_APPLY_THEN_AWAIT = `  const onSelect = useCallback(async (id: string) => {
    applyWorkspace(await getWorkspace(id))
    await setActive(id)
  }, [applyWorkspace])`

describe('urutan commit workspace', () => {
  it('App tidak lagi punya dua state aktif yang di-commit terpisah', () => {
    const app = src('App.tsx')
    expect(hasSplitActiveState(app)).toBe(false)
    // Jalur commit-nya pindah ke `workspaceLifecycle`, jadi bentuk lamanya dijaga di sana juga.
    expect(hasSplitActiveState(src('workspaceLifecycle.ts'))).toBe(false)
    expect(app).toMatch(/const activeId = activeWs\?\.id \?\? null/)
  })

  it('tidak ada `await` setelah board di-commit, di callback mana pun', () => {
    // Semua pemanggil `applyWorkspace` ada di `workspaceLifecycle`. Dihitung dulu: `.every()` atas
    // daftar kosong lulus tanpa menjaga apa pun, dan file yang salah akan lulus begitu saja.
    const life = src('workspaceLifecycle.ts')
    expect(tailsAfterApply(life).length).toBeGreaterThan(0)
    expect(appliesAfterLastAwait(life)).toBe(true)
  })

  it('kedua guard menolak bentuk lamanya', () => {
    expect(hasSplitActiveState(OLD_SELECT)).toBe(true)
    expect(appliesAfterLastAwait(OLD_APPLY_THEN_AWAIT)).toBe(false)
    // Dan melewatkan bentuk yang benar, supaya bukan guard yang selalu merah.
    expect(hasSplitActiveState(src('App.tsx'))).toBe(false)
    expect(appliesAfterLastAwait('applyWorkspace(ws)\n  }, [applyWorkspace])')).toBe(true)
  })

  it('setiap pindah workspace mengambil board DULU, lewat variabel, bukan di dalam commit', () => {
    // `const ws = await getWorkspace(...)` di tiap jalur: boot, pilih tab, dan hapus workspace.
    expect(src('workspaceLifecycle.ts').match(/const ws = .*getWorkspace\(/g)?.length).toBe(3)
  })
})

/**
 * Klik minimap memindahkan viewport lewat `setCenter`. `onMoveEnd` kemungkinan besar tetap jalan
 * untuk perpindahan programatik (`setTransform` tidak mengirim `sourceEvent`, jadi bukan `internal`),
 * tapi `syncViewport` di sampingnya adalah persist yang disengaja supaya posisi baru tak bergantung
 * pada jalur event — itu bagian yang paling mudah terhapus saat orang menyunting blok `<MiniMap>`
 * nanti, jadi keduanya dijaga sebagai satu pasangan.
 */
const minimapJsx = (s: string) => s.split('<MiniMap')[1]?.split('/>')[0] ?? ''
const clickIsSynced = (s: string) => {
  const m = minimapJsx(s)
  return /\bonClick=/.test(m) && /\bsetCenter\(/.test(m) && /\bsyncViewport\(/.test(m)
}

// Bentuk sebelum klik dipasang, untuk membuktikan guard di atas benar-benar menggigit.
const OLD_MINIMAP = '<MiniMap className="minimap-dock" pannable zoomable nodeColor={nodeColor} />'

describe('klik minimap', () => {
  it('punya handler klik yang memindahkan viewport DAN mempersistnya', () => {
    expect(clickIsSynced(src('App.tsx'))).toBe(true)
  })

  it('zoom berjalan diteruskan eksplisit — `setCenter` tanpa `zoom` melompat ke maxZoom', () => {
    expect(minimapJsx(src('App.tsx'))).toMatch(/zoom: vp\.zoom/)
  })

  it('guard menolak minimap tanpa klik, dan klik tanpa sync', () => {
    expect(clickIsSynced(OLD_MINIMAP)).toBe(false)
    expect(clickIsSynced('<MiniMap onClick={(_, p) => rf.current?.setCenter(p.x, p.y)} />')).toBe(false)
  })
})

describe('gerbang hidrasi', () => {
  it('`Welcome` tidak dirender sebelum fetch pertama selesai', () => {
    // Tiga keadaan, bukan dua: belum tahu (tidak merender apa pun), tidak ada workspace, ada.
    expect(src('App.tsx')).toMatch(/\{!hydrated \? null : noWorkspaces \? \(/)
  })

  it('dock ikut digerbang — ia hanya milik board yang sudah ada', () => {
    expect(src('App.tsx')).toMatch(/\{hydrated && !noWorkspaces && \(/)
  })

  it('header TIDAK digerbang: tombol `+`-nya satu-satunya jalan masuk di layar Welcome', () => {
    const app = src('App.tsx')
    expect(app.indexOf('<WorkspaceBar')).toBeLessThan(app.indexOf('!hydrated'))
  })
})
