import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { spawnPosition } from './nodeSpawn'

const NODE = { width: 400, height: 300 }
const CENTER = { x: 1000, y: 500 }

describe('spawnPosition', () => {
  it('memusatkan node di titik pandang, bukan menaruh sudutnya di sana', () => {
    // Tanpa dikurangi separuh ukuran, node melenceng (200,150) ke kanan-bawah dari yang dilihat.
    expect(spawnPosition(CENTER, NODE, 0)).toEqual({ x: 800, y: 350 })
  })

  it('ikut ukuran node: node yang lebih besar mundur lebih jauh dari titik pandang', () => {
    expect(spawnPosition(CENTER, { width: 800, height: 600 }, 0)).toEqual({ x: 600, y: 200 })
  })

  it('offsetnya BERPUTAR, jadi node ke-n tidak berjalan keluar layar seperti tangga lamanya', () => {
    // Inti bug lama: `80 + n * 40` terus menjauh. Di sini n=6 kembali ke posisi n=0.
    expect(spawnPosition(CENTER, NODE, 6)).toEqual(spawnPosition(CENTER, NODE, 0))
    expect(spawnPosition(CENTER, NODE, 13)).toEqual(spawnPosition(CENTER, NODE, 1))
    // Dan simpangan terbesarnya tetap kecil, berapa pun n.
    for (const n of [0, 5, 40, 999]) {
      const p = spawnPosition(CENTER, NODE, n)
      expect(p.x - 800).toBeLessThanOrEqual(5 * 36)
      expect(p.y - 350).toBeLessThanOrEqual(5 * 36)
    }
  })

  it('dua node berturut-turut tidak menumpuk persis', () => {
    expect(spawnPosition(CENTER, NODE, 1)).not.toEqual(spawnPosition(CENTER, NODE, 0))
  })
})

// Titik lahir dihitung dari viewport, dan viewport hanya ada di DOM — vitest webterm jalan di
// node-env, jadi yang bisa dilakukan untuk bagian itu: membaca source-nya dan menolak bentuk yang
// salah, pola yang sama dengan `nodeRender.test.ts` / `workspaceCommit.test.ts`.
const src = (f: string) => readFileSync(fileURLToPath(new URL(`./${f}`, import.meta.url)), 'utf8')

const ADDERS = ['onAddTerminal', 'onAddFiles', 'onAddAgent']

/** Potongan dari tiap `const onAdd... = useCallback(` sampai ujung dep array-nya. */
const adderBody = (s: string, name: string) =>
  s.split(`const ${name} = useCallback(`)[1]?.split('[addFlowNode])')[0] ?? ''

/** x/y yang ditulis sendiri si pemanggil = penempatan yang buta viewport. */
const setsOwnXY = (t: string) => /\bx:\s|\by:\s/.test(t)

const spawnsAtViewportCenter = (s: string) =>
  /spawnAt\(rf\.current/.test(s) && ADDERS.every((n) => adderBody(s, n) !== '' && !setsOwnXY(adderBody(s, n)))

// Bentuk lama, persis seperti sebelum dibetulkan. Dipakai untuk membuktikan guard di bawah
// benar-benar menggigit, bukan lulus karena polanya mustahil ditemukan.
const OLD_ADDERS = `  const onAddTerminal = useCallback(() => {
    addFlowNode((n, ws) => ({ id: crypto.randomUUID(), kind: 'terminal', x: 80 + n * 40, y: 80 + n * 40, cwd: ws.cwd }))
  }, [addFlowNode])

  const onAddFiles = useCallback(() => {
    addFlowNode((n, ws) => ({ id: crypto.randomUUID(), kind: 'files', x: 80 + n * 40, y: 80 + n * 40, dirPath: ws.cwd }))
  }, [addFlowNode])

  const onAddAgent = useCallback((cmd: string, agentId: AgentId, cwd?: string) => {
    addFlowNode((n, ws) => ({ id: crypto.randomUUID(), kind: 'agent', x: 80 + n * 40, y: 80 + n * 40, cmd, agentId }))
  }, [addFlowNode])`

describe('titik lahir node baru di App', () => {
  it('tangga diagonal `80 + n * 40` sudah tidak ada lagi', () => {
    expect(src('App.tsx')).not.toMatch(/80 \+ n \* 40/)
  })

  it('ketiga tombol tambah memakai tengah viewport, tak satu pun menaruh x/y sendiri', () => {
    expect(spawnsAtViewportCenter(src('App.tsx'))).toBe(true)
  })

  it('node baru ditandai terseleksi — round-trip toFlow membuang `selected` yang lain', () => {
    expect(src('App.tsx')).toMatch(/next\[next\.length - 1\]\.selected = true/)
  })

  it('guardnya menolak bentuk lamanya', () => {
    expect(OLD_ADDERS).toMatch(/80 \+ n \* 40/)
    expect(spawnsAtViewportCenter(OLD_ADDERS)).toBe(false)
    // Dan tidak lulus hanya karena potongannya gagal diambil.
    for (const n of ADDERS) expect(setsOwnXY(adderBody(OLD_ADDERS, n))).toBe(true)
  })
})
