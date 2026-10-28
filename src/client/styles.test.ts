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
      '.minimap-dock', '.ws-switcher', '.ws-switcher-item', '.ws-switcher-item--active',
      '.btn', '.btn--accent', '.btn--ghost', '.field', '.panel', '.bridge-handle',
    ]) {
      expect(tokens).toContain(cls)
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

  it('defines the rest of the chrome vocabulary', () => {
    for (const cls of [
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
    expect(plate).toContain('padding: 7px')
    expect(plate).toContain('border-radius: 16px')
    expect(plate).toContain('background: rgba(var(--menu-rgb), 0.92)')
    expect(plate).toContain('backdrop-filter: blur(10px)')
    expect(plate).toContain('box-shadow: 0 10px 32px rgba(0, 0, 0, calc(0.5 * var(--shadow-k)))')
  })

  it('matches nodeterm dock button metrics', () => {
    const btn = dock.slice(dock.indexOf('.dock-btn {'), dock.indexOf('.dock-btn:hover'))
    expect(btn).toContain('width: 38px')
    expect(btn).toContain('height: 38px')
    expect(btn).toContain('border-radius: 10px')
    expect(dock).toContain('.dock-add { background: var(--accent); color: #fff; }')
    expect(dock).toContain('color-mix(in srgb, var(--accent) 85%, black)')
    const sep = dock.slice(dock.indexOf('.dock-sep {'), dock.indexOf('.dock-dirty {'))
    expect(sep).toContain('height: 22px')
    expect(sep).toContain('margin: 0 4px')
  })

  it('defines the dirty marker, the zoom readout and the menus', () => {
    expect(dock).toContain('.dock-dirty.dirty { background: var(--caution); }')
    expect(dock.slice(dock.indexOf('.dock-zoom {'))).toContain('min-width: 52px')
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
    ]) {
      expect(all).not.toContain(gone)
    }
  })
})
