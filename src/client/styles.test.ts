import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

const read = (f: string) => readFileSync(fileURLToPath(new URL(`./${f}`, import.meta.url)), 'utf8')

const tokens = read('styles.css')
const chrome = read('node-chrome.css')
const dock = read('dock.css')
const all = tokens + chrome + dock

describe('styles.css — token sheet', () => {
  it('chains the component sheets before any rule (CSS @import requirement)', () => {
    const firstRule = tokens.indexOf('{')
    expect(tokens.indexOf("@import './node-chrome.css'")).toBeLessThan(firstRule)
    expect(tokens.indexOf("@import './dock.css'")).toBeLessThan(firstRule)
  })

  it('defines core surface/accent/status tokens', () => {
    for (const tok of [
      '--canvas-bg: #000000',
      '--bg: #1e1e1e',
      '--panel: #282828',
      '--accent: #0a84ff',
      '--state-working: #d97757',
      '--state-attention: #ff453a',
      '--radius-node: 10px',
      '--float-gap: 22px',
      // Tinggi header bar. Dipaku: `canvas-ui.css` menurunkan cluster kontrol dengan token ini,
      // dan nilainya harus sama dengan `--ss-top-chrome` (46px) di `sessions-panel.css` supaya
      // sidebar sesi dan cluster itu mengapung di baris yang sama di bawah header.
      '--tabbar-h: 46px',
    ]) {
      expect(tokens).toContain(tok)
    }
  })

  it('defines the tokens other workers consume', () => {
    for (const tok of [
      '--tint-rgb: 255, 255, 255',
      '--menu-rgb: 40, 40, 42',
      '--card-rgb: 28, 28, 30',
      '--shadow-k: 1',
      '--controls-w: 30px',
      '--caution: #ffd60a',
    ]) {
      expect(tokens).toContain(tok)
    }
  })

  it('routes overlays through --tint-rgb so a theme flip is one declaration', () => {
    expect(tokens).toContain('--border: rgba(var(--tint-rgb), 0.1)')
    expect(tokens).toContain('--text: rgba(var(--tint-rgb), 0.85)')
    expect(tokens).toContain('--shadow-node: 0 8px 28px rgba(0, 0, 0, calc(0.4 * var(--shadow-k)))')
  })

  it('ships a light theme that re-points the same tokens', () => {
    expect(tokens).toContain(":root[data-theme='light']")
    const light = tokens.slice(tokens.indexOf(":root[data-theme='light']"))
    for (const tok of ['--tint-rgb: 58, 48, 38', '--bg: #fbf8f3', '--shadow-k: 0.35', '--caution: #806100']) {
      expect(light).toContain(tok)
    }
  })

  it('keeps the shared controls and canvas furniture', () => {
    for (const cls of [
      '.minimap-dock', '.app-shell', '.app-main',
      '.btn', '.btn--accent', '.btn--ghost', '.field', '.panel', '.bridge-handle',
    ]) {
      expect(tokens).toContain(cls)
    }
  })

  it('lays the app out as header + canvas, not an overlay floating over the canvas', () => {
    const shell = tokens.slice(tokens.indexOf('.app-shell {'), tokens.indexOf('/* ---- Header bar'))
    expect(shell).toContain('flex-direction: column')
    // Tanpa min-height: 0 tinggi minimum flex item jatuh ke tinggi kontennya dan canvas
    // mendorong header keluar layar; tanpa flex-basis definit `height: 100%` ReactFlow runtuh.
    expect(shell).toContain('flex: 1 1 0')
    expect(shell).toContain('min-height: 0')
    // Welcome memposisikan diri dengan `inset: 0` — containing block-nya harus .app-main.
    expect(shell).toContain('position: relative')
    const bar = tokens.slice(tokens.indexOf('.tabbar {'), tokens.indexOf('.brand {'))
    expect(bar).toContain('height: var(--tabbar-h)')
    expect(bar).toContain('flex-shrink: 0')
    expect(bar).not.toContain('position: absolute')
  })

  it('keeps the tab strip on one line and the + reachable with many workspaces', () => {
    const strip = tokens.slice(tokens.indexOf('.tabbar__projects {'), tokens.indexOf('.tab {'))
    expect(strip).toContain('overflow-x: auto')
    // Dua min-width: 0 + flex-shrink: 0 pada tombolnya adalah yang menahan `+` di dalam layar.
    expect((strip.match(/min-width: 0/g) ?? []).length).toBe(2)
    const add = tokens.slice(tokens.indexOf('.tab__add {'))
    expect(add).toContain('flex-shrink: 0')
  })

  it('keeps the tab kebab reachable and visible without hovering', () => {
    const caret = tokens.slice(tokens.indexOf('.tab__caret {'), tokens.indexOf('.tab:hover .tab__caret'))
    // Kotak tetap + glyph 14px: lucide menulis ukurannya sebagai atribut, jadi tanpa aturan svg
    // tombolnya jadi 24px dan merusak tinggi baris tab.
    expect(caret).toContain('width: 22px')
    expect(caret).toContain('height: 22px')
    expect(tokens.slice(tokens.indexOf('.tab__caret svg {'))).toContain('width: 14px')
    // Affordance rename/hapus satu-satunya: ia tidak boleh hanya muncul saat hover.
    expect(caret).toContain('opacity: 0.45')
    // Nama sepanjang kalimat tidak boleh memeras tombolnya sampai nol.
    const actions = tokens.slice(tokens.indexOf('.tab__actions {'), tokens.indexOf('.tab__caret {'))
    expect(actions).toContain('flex-shrink: 0')
    // Tepi kanan tab berakhir di kebab, jadi padding-nya asimetris (seperti nodeterm).
    expect(tokens.slice(tokens.indexOf('.tab {'), tokens.indexOf('.tab:hover'))).toContain('padding: 0 4px 0 10px')
  })

  it('keeps the inline rename input inside the tab instead of widening it', () => {
    const edit = tokens.slice(tokens.indexOf('.tab__edit {'), tokens.indexOf('.tab__actions {'))
    // Lebar konten input default (~20 karakter) akan mendorong tab melewati max-width 220px-nya.
    expect(edit).toContain('flex: 1 1 0')
    expect(edit).toContain('width: 0')
    expect(edit).toContain('min-width: 48px')
  })

  it('gives every tab dot kind a colour, neutral included', () => {
    for (const kind of ['neutral', 'idle', 'working', 'attention']) {
      expect(tokens).toContain(`.tab__dot--${kind} {`)
    }
  })
})

describe('node-chrome.css', () => {
  it('leaves the node border-top COLOR to the inline style of each node', () => {
    const frame = chrome.slice(chrome.indexOf('.term-node {'), chrome.indexOf('.term-node--selected'))
    expect(frame).toContain('border-top-width: 3px')
    expect(frame).not.toContain('border-top-color')
  })

  it('hangs the status glow outside .term-node, which clips its own ::after', () => {
    expect(chrome).toContain('overflow: hidden')
    expect(chrome).toContain('.react-flow__node:has(.term-node.working)::after')
    expect(chrome).toContain('.react-flow__node:has(.term-node.attention)::after')
  })

  it('animates opacity only, and bounds the working pulse to four cycles', () => {
    expect(chrome).toContain('animation: nt-working-glow 2.6s ease-in-out 4')
    expect(chrome).toContain('@keyframes nt-working-glow')
    expect(chrome).toContain('@keyframes nt-attention-glow')
    const working = chrome.slice(chrome.indexOf('@keyframes nt-working-glow'), chrome.indexOf('.term-node.attention'))
    expect(working).toContain('opacity')
    expect(working).not.toContain('box-shadow')
  })

  it('keeps the glows lit (static) under reduced motion instead of dropping the status', () => {
    const rm = chrome.slice(chrome.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(rm).toContain('animation: none')
    expect(rm).toContain('opacity: 0.7')
  })

  it('matches nodeterm header metrics', () => {
    const title = chrome.slice(chrome.indexOf('.node-title {'), chrome.indexOf('.node-title:hover'))
    expect(title).toContain('max-width: 220px')
    expect(title).toContain('padding: 2px 5px')
    expect(title).toContain('font-size: 13px')
    expect(title).toContain('font-weight: 600')
    // Judul tidak boleh melar: toolbar yang didorong `margin-left: auto`, bukan judul.
    expect(title).not.toContain('flex: 1')
    expect(chrome).toContain('.node-toolbar { display: flex; align-items: center; gap: 2px; margin-left: auto; }')
    const icon = chrome.slice(chrome.indexOf('.icon-btn {'), chrome.indexOf('.icon-btn:hover'))
    expect(icon).toContain('border-radius: 4px')
    expect(chrome).toContain('background: rgba(var(--tint-rgb), 0.1)')
    expect(chrome).toContain('border-radius: 50%')
  })

  it('styles the status chip without text-transform (nodeterm labels are literal)', () => {
    const chip = chrome.slice(chrome.indexOf('.node-status {'), chrome.indexOf('@keyframes nt-pulse'))
    expect(chip).toContain('letter-spacing: 0.06em')
    expect(chip).toContain('.node-status-dot')
    expect(chip).toContain('.node-status--busy')
    expect(chip).toContain('.node-status--attention')
    expect(chip).not.toContain('text-transform')
  })

  it('leaves split-pane geometry to each pane inline style, and sizes dividers per axis', () => {
    expect(chrome).toContain('.pane-host { position: relative; width: 100%; height: 100%; }')
    // `.pane` TIDAK boleh menyebut ukuran: tiap pane diposisikan `paneLayout` lewat inline style,
    // dan satu deklarasi di sini menimpanya untuk SEMUA pane sekaligus — keempat pane 2×2 akan
    // menumpuk di satu tempat. Satu-satunya blok `.pane {`, supaya aturan kedua di bawahnya (yang
    // justru dipakai cascade) tidak lolos.
    expect(chrome.match(/^\.pane \{/gm) ?? []).toHaveLength(1)
    const leaf = chrome.slice(chrome.indexOf('.pane {'), chrome.indexOf('/* Penanda pane aktif'))
    expect(leaf).toContain('position: absolute')
    expect(leaf).not.toContain('width')
    expect(leaf).not.toContain('height')
    // Sumbu pembatas, kontrak yang sama yang dibaca `ratioFromPointer`: 'h' membelah sumbu x jadi
    // pembatasnya TEGAK dan tebalnya `width`; 'v' sebaliknya. Tertukar = pita setipis nol yang
    // tidak bisa ditangkap kursor.
    expect(chrome).toContain(".pane-divider[aria-orientation='vertical'] { width: 6px; cursor: col-resize; }")
    expect(chrome).toContain(".pane-divider[aria-orientation='horizontal'] { height: 6px; cursor: row-resize; }")
  })

  it('defines the rest of the chrome vocabulary', () => {
    for (const cls of [
      '.pane-host', '.pane--active', '.pane-divider', '.pane-split-btns',
      '.node-header', '.node-title--edit', '.node-swatch', '.node-swatch-pop',
      '.icon-btn--danger', '.icon-btn--active', '.node-chevron', '.node-chevron--collapsed',
      '.node-body', '.term-node--collapsed',
      '.usage-pill', '.usage-pill__label', '.usage-pill__minibar', '.usage-pill__fill',
      '.node-comments', '.node-comments__composer',
    ]) {
      expect(chrome).toContain(cls)
    }
  })
})

describe('dock.css', () => {
  it('matches nodeterm dock plate metrics', () => {
    const plate = dock.slice(dock.indexOf('.dock {'), dock.indexOf('.dock-btn {'))
    // Nilai nodeterm-nya kini hidup di token `--dock-pad`, karena `--dock-w` dihitung darinya.
    expect(dock).toContain('--dock-pad: 7px')
    expect(plate).toContain('padding: var(--dock-pad)')
    expect(plate).toContain('border-radius: 16px')
    expect(plate).toContain('background: rgba(var(--menu-rgb), 0.92)')
    expect(plate).toContain('backdrop-filter: blur(10px)')
    expect(plate).toContain('box-shadow: 0 10px 32px rgba(0, 0, 0, calc(0.5 * var(--shadow-k)))')
  })

  it('matches nodeterm dock button metrics', () => {
    const btn = dock.slice(dock.indexOf('.dock-btn {'), dock.indexOf('.dock-btn:hover'))
    expect(dock).toContain('--dock-btn-size: 38px')
    expect(btn).toContain('width: var(--dock-btn-size)')
    expect(btn).toContain('height: var(--dock-btn-size)')
    expect(btn).toContain('border-radius: 10px')
    expect(dock).toContain('.dock-add { background: var(--accent); color: #fff; }')
    expect(dock).toContain('color-mix(in srgb, var(--accent) 85%, black)')
    // Dock adalah KOLOM di tepi kiri, bukan bar di bawah: pemisahnya garis horizontal (panjang
    // nodeterm 22px pindah ke lebar) dan menunya harus terbuka ke kanan, bukan ke atas.
    const sep = dock.slice(dock.indexOf('.dock-sep {'), dock.indexOf('.dock-dirty {'))
    expect(sep).toContain('width: 22px')
    expect(sep).toContain('margin: 4px 0')
  })

  it('lays the dock out as a left-edge column with menus opening to the right', () => {
    const plate = dock.slice(dock.indexOf('.dock {'), dock.indexOf('.dock-btn {'))
    expect(plate).toContain('flex-direction: column')
    expect(plate).toContain('left: var(--float-gap)')
    expect(plate).not.toContain('translateX(-50%)')
    const menu = dock.slice(dock.indexOf('.dock-menu {'), dock.indexOf('.dock-menu__list {'))
    expect(menu).toContain('left: calc(100% + 10px)')
    expect(menu).not.toContain('bottom: calc(100% + 10px)')
  })

  it('defines the dirty marker, the zoom readout and the menus', () => {
    expect(dock).toContain('.dock-dirty.dirty { background: var(--caution); }')
    // Selebar tombol: readout teks tidak boleh melebarkan kolom.
    expect(dock.slice(dock.indexOf('.dock-zoom {'))).toContain('min-width: var(--dock-btn-size)')
    for (const cls of [
      '.dock-backdrop', '.dock-slot', '.dock-menu', '.dock-add-menu', '.dock-menu__list',
      '.dock-menu__glyph', '.dock-menu__rule', '.dock-menu__check', '.dock-menu__form',
      '.dock-zoom-menu',
    ]) {
      expect(dock).toContain(cls)
    }
  })
})

describe('CSS mati sudah dibuang', () => {
  it('drops selectors and keyframes no component renders any more', () => {
    for (const gone of [
      '.node-mdhint',        // hint markdown yang tak pernah dirender
      '.node-labeladd',      // chip '+ Label' — nodeterm memakai fallback teks 'Untitled'
      '.node-status-text',   // teks chip sekarang bagian dari .node-status
      '.dock-flyout',        // digantikan .dock-menu
      'pulse-working',       // digantikan nt-pulse / nt-working-glow
      '.ws-switcher',        // pil melayang, digantikan header bar .tabbar
    ]) {
      expect(all).not.toContain(gone)
    }
  })
})
