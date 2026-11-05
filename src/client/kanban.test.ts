import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

// Kanban memposisikan dirinya lewat kelas Tailwind, bukan inline style, jadi tak ada CSS untuk
// diperiksa seperti di styles.test.ts dan komponennya tak bisa dirender (vitest repo ini node-env,
// tanpa DOM). Yang dites: dua jaminan yang kalau hilang membuat overlay tak bisa ditutup lagi.
// Kelasnya dibaca dari source karena itu satu-satunya kontrak yang tersisa — pola yang sama dengan
// workspaceBarChrome.test.ts.
const src = readFileSync(fileURLToPath(new URL('./Kanban.tsx', import.meta.url)), 'utf8')

/** Kelas pada div overlay teratas: elemen pertama yang memasang `absolute` di file ini. */
const overlayClass = (): string => /className="([^"]*\babsolute\b[^"]*)"/.exec(src)?.[1] ?? ''

describe('Kanban — overlay harus bisa ditutup', () => {
  it('menurunkan overlay di bawah tab bar, bukan inset-0 yang menenggelamkan tombol Close', () => {
    const cls = overlayClass()
    // Kelas yang tak ditemukan memulangkan string kosong; guard di bawahnya akan menjawab tanpa
    // menjaga apa pun, jadi keberadaan `absolute` diperiksa lebih dulu.
    expect(cls).toContain('absolute')
    expect(cls).toContain('top-[var(--tabbar-h,0px)]')
    expect(cls).not.toContain('inset-0')
    // Harus menang atas .tabbar (30) yang menutupi baris header.
    const z = /(?:^|\s)z-(\d+)/.exec(cls)?.[1]
    expect(Number(z)).toBeGreaterThan(30)
  })

  it('tidak menyisakan inline style di seluruh komponen', () => {
    expect(src).not.toMatch(/style=\{\{/)
  })

  it('menyediakan Escape sebagai jalan keluar kedua dan membersihkan listener-nya', () => {
    expect(src).toContain("e.key === 'Escape'")
    expect(src).toContain("window.addEventListener('keydown', onKey)")
    expect(src).toContain("window.removeEventListener('keydown', onKey)")
  })
})
