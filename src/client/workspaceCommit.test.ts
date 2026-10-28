import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Yang dijaga di sini adalah URUTAN di App.tsx, dan urutan hanya hidup di JSX/callback — vitest
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
    expect(app).toMatch(/const activeId = activeWs\?\.id \?\? null/)
  })

  it('tidak ada `await` setelah board di-commit, di callback mana pun', () => {
    expect(appliesAfterLastAwait(src('App.tsx'))).toBe(true)
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
    expect(src('App.tsx').match(/const ws = .*getWorkspace\(/g)?.length).toBe(3)
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
