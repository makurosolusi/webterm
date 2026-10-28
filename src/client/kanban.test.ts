import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

// Kanban memposisikan dirinya dengan inline style, jadi tak ada CSS untuk diperiksa seperti di
// styles.test.ts dan komponennya tak bisa dirender (vitest repo ini node-env, tanpa DOM).
// Yang dites: dua jaminan yang kalau hilang membuat overlay tak bisa ditutup lagi.
const src = readFileSync(fileURLToPath(new URL('./Kanban.tsx', import.meta.url)), 'utf8')

describe('Kanban — overlay harus bisa ditutup', () => {
  it('menurunkan overlay di bawah tab bar, bukan inset: 0 yang menenggelamkan tombol Close', () => {
    // Dipotong ke objek style overlay saja: kata `inset: 0` juga muncul di komentar di atasnya.
    const style = src.slice(src.indexOf("position: 'absolute'"), src.indexOf('background:'))
    expect(style).toContain("top: 'var(--tabbar-h, 0px)'")
    expect(style).not.toContain('inset: 0')
    // Harus menang atas .controls-cluster (z-index 26) dan .tabbar (30) yang menutupi baris header.
    expect(Number(/zIndex: (\d+)/.exec(style)?.[1])).toBeGreaterThan(30)
  })

  it('menyediakan Escape sebagai jalan keluar kedua dan membersihkan listener-nya', () => {
    expect(src).toContain("e.key === 'Escape'")
    expect(src).toContain("window.addEventListener('keydown', onKey)")
    expect(src).toContain("window.removeEventListener('keydown', onKey)")
  })
})
