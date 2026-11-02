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
      // Geometri chrome VS Code. Dipaku: grid `.app-shell` memakai keempatnya, dan primitif
      // `components/vscode/vscode-shell.css` menggambar tinggi yang sama.
      '--title-bar-h: 35px',
      '--editor-tabs-h: 35px',
      '--activity-bar-w: 48px',
      '--status-bar-h: 22px',
      // Alias warisan untuk sheet yang belum ikut migrasi: tinggi chrome di atas canvas.
      '--tabbar-h: calc(var(--title-bar-h) + var(--editor-tabs-h))',
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

  it('keeps shared layout and canvas furniture', () => {
    for (const cls of ['.minimap-dock', '.app-shell', '.app-main', '.bridge-handle']) {
      expect(tokens).toContain(cls)
    }
  })
  it('leaves legacy control selectors absent after shadcn migration', () => {
    for (const gone of ['.btn', '.btn--accent', '.btn--ghost', '.field', '.panel']) {
      expect(tokens).not.toContain(gone)
    }
  })

  it('lays the app out as a VS Code shell grid: title / tabs / rail+canvas / status', () => {
    const shell = tokens.slice(tokens.indexOf('.app-shell {'), tokens.indexOf('.app-shell--auth {'))
    expect(shell).toContain('display: grid')
    expect(shell).toContain(
      'grid-template-rows: var(--title-bar-h) var(--editor-tabs-h) minmax(0, 1fr) var(--status-bar-h)',
    )
    // Kolom sidebar selebar 0 saat tertutup; `--sidebar` (di App) membukanya menjadi 300px tanpa
    // menggeser rail. Canvas tetap `minmax(0, 1fr)` supaya ia yang menyerap sisa lebar.
    expect(shell).toContain('grid-template-columns: var(--activity-bar-w) 0 minmax(0, 1fr)')
    expect(shell).toContain("'activity sidebar main'")
    expect(tokens).toContain('.app-shell--sidebar {')
    const open = tokens.slice(tokens.indexOf('.app-shell--sidebar {'))
    expect(open.slice(0, open.indexOf('}'))).toContain('300px')

    // Welcome memposisikan diri dengan `inset: 0` — containing block-nya harus .app-main, dan
    // min-width/height: 0 menahan isi canvas agar tidak mendorong grid melewati viewport.
    const main = tokens.slice(tokens.indexOf('.app-main {'), tokens.indexOf('/* ---- Title bar'))
    expect(main).toContain('grid-area: main')
    expect(main).toContain('position: relative')
    expect(main).toContain('min-height: 0')
    expect(main).toContain('min-width: 0')

    for (const [selector, area] of [
      ['.app-titlebar {', 'title'],
      ['.app-tabs {', 'tabs'],
      ['.app-statusbar {', 'status'],
    ]) {
      const block = tokens.slice(tokens.indexOf(selector))
      expect(block.slice(0, block.indexOf('}'))).toContain(`grid-area: ${area}`)
    }
  })

  it('collapses every chrome row in clean view, not just hides the elements', () => {
    const clean = tokens.slice(tokens.indexOf('body.clean-view .app-shell {'))
    expect(clean).toContain('grid-template-rows: 0 0 minmax(0, 1fr) 0')
    expect(clean).toContain('grid-template-columns: 0 minmax(0, 1fr)')
    for (const selector of ['.app-titlebar', '.app-tabs', '.app-statusbar']) {
      expect(tokens).toContain(`body.clean-view ${selector}`)
    }
  })

  it('keeps the editor tab row one line: strip shrinks, actions never do', () => {
    const row = tokens.slice(tokens.indexOf('.app-tabs {'), tokens.indexOf('.app-tabs__action {'))
    expect(row).toContain('display: flex')
    expect(row).toContain('min-width: 0')
    const strip = tokens.slice(tokens.indexOf('.app-tabs > .vscode-editor-tabs'))
    expect(strip.slice(0, strip.indexOf('}'))).toContain('min-width: 0')
    const actions = tokens.slice(tokens.indexOf('.app-tabs__actions {'), tokens.indexOf('.app-tabs__action {'))
    expect(actions).toContain('flex: none')
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
    // Tombol header kini murni shadcn (`size="icon-xs"`); base `.icon-btn` sudah dihapus dan
    // kini tombol header memakai `vscode-toolbar-button`; kelas status lama ikut dihapus.
    expect(chrome).not.toContain('.icon-btn {')
    expect(chrome).not.toContain('.icon-btn:hover')
    expect(chrome).not.toContain('.icon-btn--active')
    expect(chrome).not.toContain('.icon-btn--danger')
    expect(chrome).toContain(".node-toolbar vscode-toolbar-button[aria-disabled='true']")
    expect(chrome).toContain('.node-toolbar__danger')
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
      '.node-toolbar__danger', '.node-toolbar__count', '.node-chevron', '.node-chevron--collapsed',
      '.node-find__field', '.node-find__actions',
      '.node-body', '.term-node--collapsed',
      '.usage-pill', '.usage-pill__label', '.usage-pill__minibar', '.usage-pill__fill',
      '.node-comments', '.node-comments__composer',
    ]) {
      expect(chrome).toContain(cls)
    }
  })
})

describe('dock.css — activity bar rail', () => {
  it('places the rail in the shell grid instead of anchoring it over the canvas', () => {
    const plate = dock.slice(dock.indexOf('.dock {'), dock.indexOf('.dock > .vscode-activity-bar {'))
    expect(plate).toContain('grid-area: activity')
    expect(plate).toContain('display: flex')
    expect(plate).toContain('flex-direction: column')
    // z-index 20 dipertahankan: panel sesi mengapung di z-12 dan tidak boleh menutupi rail.
    expect(plate).toContain('z-index: 20')
    expect(plate).toContain('background: var(--vscode-activityBar-background')
    expect(plate).not.toContain('position: absolute')
    expect(plate).not.toContain('backdrop-filter')
  })

  it('derives the shared panel offset from the 48px activity bar', () => {
    // Satu sumber lebar rail: `sessions-panel.css` dan `inbox.css` membaca token ini.
    const token = dock.slice(dock.indexOf(':root {'), dock.indexOf('/* Grid item'))
    expect(token).toContain('--dock-w: var(--activity-bar-w)')
    expect(dock).not.toContain('--dock-btn-size: 38px')
    expect(dock).not.toContain('--dock-pad: 7px')
  })

  it('keeps the primitive activity bar flush inside the rail', () => {
    const primitive = dock.slice(dock.indexOf('.dock > .vscode-activity-bar {'))
    expect(primitive.slice(0, primitive.indexOf('}'))).toContain('width: 100%')
    expect(primitive.slice(0, primitive.indexOf('}'))).toContain('background: transparent')
  })

  it('renders the lock/clean toggles with aria-pressed at VS Code rail width', () => {
    const modes = dock.slice(dock.indexOf('.dock__modes {'), dock.indexOf('.dock-btn {'))
    expect(modes).toContain('flex-direction: column')
    const btn = dock.slice(dock.indexOf('.dock-btn {'), dock.indexOf('.dock-btn:hover'))
    expect(btn).toContain('width: 100%')
    expect(btn).toContain('height: 40px')
    expect(btn).toContain('border-left: 2px solid transparent')
    expect(dock).toContain(".dock-btn[aria-pressed='true']")
    expect(dock).toContain('--vscode-activityBar-activeBorder')
    expect(dock).toContain('.dock-btn svg {')
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
