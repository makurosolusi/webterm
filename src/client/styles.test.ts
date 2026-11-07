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
      // Palet = variabel resmi Dark/Light Modern (`vscode-theme.css`); token lama hanya menunjuk ke sana.
      '--bg: var(--vscode-editor-background)',
      '--panel: var(--vscode-sideBar-background)',
      '--accent: var(--vscode-focusBorder)',
      '--state-working: #d97757',
      '--state-attention: #ff453a',
      '--float-gap: 22px',
      // Geometri chrome VS Code. Dipaku: grid `.app-shell` memakai keempatnya, dan primitif
      // `components/vscode/vscode-shell.css` menggambar tinggi yang sama.
      '--title-bar-h: 35px',
      '--editor-tabs-h: 35px',
      '--activity-bar-w: 48px',
      '--status-bar-h: 22px',
      // Alias warisan untuk sheet yang belum ikut migrasi: tinggi chrome di atas canvas.
      '--tabbar-h: calc(var(--title-bar-h) + var(--editor-tabs-h))',
      // Ukuran chrome = default workbench VS Code; satu sumber yang dibaca semua sheet chrome.
      '--ui-font-size: var(--vscode-font-size)',
      '--ui-font-size-small: 12px',
      '--ui-font-size-label: 11px',
      '--ui-icon-size: 16px',
      '--activity-icon-size: 24px',
      '--status-font-size: var(--ui-font-size-small)',
      '--list-row-h: 22px',
      '--menu-row-h: 24px',
    ]) {
      expect(tokens).toContain(tok)
    }
  })

  it('defines the tokens other workers consume', () => {
    for (const tok of [
      '--tint-rgb: 255, 255, 255',
      '--menu-rgb: 31, 31, 31',
      '--shadow-k: 1',
    ]) {
      expect(tokens).toContain(tok)
    }
  })

  it('routes overlays through --tint-rgb so a theme flip is one declaration', () => {
    expect(tokens).toContain('--muted-2: rgba(var(--tint-rgb), 0.25)')
    expect(tokens).toContain('--border: var(--vscode-panel-border)')
    expect(tokens).toContain('--text: var(--vscode-foreground)')
  })

  it('ships a light theme that re-points the same tokens', () => {
    expect(tokens).toContain(":root[data-theme='light']")
    const light = tokens.slice(tokens.indexOf(":root[data-theme='light']"))
    for (const tok of ['--tint-rgb: 59, 59, 59', '--menu-rgb: 255, 255, 255', '--shadow-k: 0.35']) {
      expect(light).toContain(tok)
    }
  })

  it('canvas lebih dalam dari badan node (editor.background) dan sideBar di Dark & Light', () => {
    // Luminansi relatif WCAG dari hex; canvas = color-mix(editor-bg P%, black) dihitung ulang di sini.
    const lum = (rgb: number[]) => {
      const [r, g, b] = rgb.map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 })
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    const ratio = (a: number[], b: number[]) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05) }
    const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
    const rule = (src: string, from: string) => src.slice(src.indexOf(from), src.indexOf('}', src.indexOf(from)))
    const cases = [
      { name: 'dark', theme: read('vscode/vscode-theme.dark.css'), block: rule(tokens, ':root {') },
      { name: 'light', theme: read('vscode/vscode-theme.light.css'), block: rule(tokens, ":root[data-theme='light']") },
    ]
    for (const { name, theme, block } of cases) {
      const pct = Number(/--canvas-bg: color-mix\(in srgb, var\(--vscode-editor-background\) (\d+)%, black\)/.exec(block)?.[1])
      expect(pct, `${name}: --canvas-bg harus color-mix dari editor-background`).toBeGreaterThan(0)
      const editor = hex(/--vscode-editor-background: (#[0-9a-f]{6})/.exec(theme)![1])
      const side = hex(/--vscode-sideBar-background: (#[0-9a-f]{6})/.exec(theme)![1])
      const canvas = editor.map((v) => Math.round((v * pct) / 100))
      // Ambang 1.1: canvas == editor (sebelum fix) = 1.0; dark #141414 vs #1f1f1f ~1.1, light #ededed vs #fff ~1.2.
      expect(ratio(canvas, editor), `${name} canvas vs editor`).toBeGreaterThanOrEqual(1.1)
      expect(canvas).not.toEqual(side)
      expect(ratio(canvas, side), `${name} canvas vs sideBar`).toBeGreaterThan(1.03)
    }
    expect(tokens).not.toContain('--canvas-bg: var(--vscode-editor-background)')
  })

  it('tidak lagi memuat token mati (tak dirujuk satu pun sheet/komponen)', () => {
    for (const dead of [
      '--accent-text', '--card-rgb', '--caution', '--controls-w', '--radius:', '--radius-sm',
      '--radius-lg', '--radius-node', '--shadow-node',
    ]) {
      expect(tokens).not.toContain(dead)
    }
  })

  it('scrollbar view 8px dengan slider radius 4px (14px hanya milik editor)', () => {
    expect(tokens).toContain('::-webkit-scrollbar { width: 8px; height: 8px; }')
    expect(tokens).toMatch(/::-webkit-scrollbar-thumb \{[^}]*border-radius: 4px/)
  })

  it('command center: 24px, radius 5px, border token commandCenter', () => {
    const pill = tokens.slice(tokens.indexOf('.app-titlebar__name {'))
    const body = pill.slice(0, pill.indexOf('}'))
    expect(body).toContain('height: 24px')
    expect(body).toContain('border-radius: 5px')
    expect(body).toContain('border: 1px solid var(--vscode-commandCenter-border)')
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
    // Kolom ke-4 `aux` = secondary side bar (Chat/Central), 0 sampai ia ter-dock (secondarySideBar.css).
    expect(shell).toContain('grid-template-columns: var(--activity-bar-w) 0 minmax(0, 1fr) var(--aux-w)')
    expect(shell).toContain("'activity sidebar main aux'")
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
    expect(clean).toContain('grid-template-columns: 0 0 minmax(0, 1fr)')
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
  it('draws the node frame as a flat 1px neutral border, never a coloured 2px top line', () => {
    const frame = chrome.slice(chrome.indexOf('.term-node {'), chrome.indexOf('.term-node--selected'))
    expect(frame).toContain('border: 1px solid var(--nc-border)')
    expect(frame).not.toContain('border-top-width')
    expect(frame).not.toContain('box-shadow')
    // Dinaikkan 12% ke foreground supaya border node terbaca di atas canvas yang lebih dalam.
    expect(chrome).toMatch(/--nc-border: color-mix\(in srgb, var\(--vscode-editorGroup-border[^;]*var\(--vscode-foreground\) 12%\)/)
    expect(chrome).not.toContain('border-top-color')
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

  it('matches VS Code tab metrics for the header', () => {
    const header = chrome.slice(chrome.indexOf('.node-header {'), chrome.indexOf('.node-icon'))
    expect(header).toContain('height: var(--nc-header-h)')
    expect(chrome).toContain('--nc-header-h: 35px')
    expect(header).toContain('cursor: default')
    const title = chrome.slice(chrome.indexOf('.node-title {'), chrome.indexOf('.node-description'))
    expect(title).toContain('max-width: 220px')
    expect(title).toContain('font-size: var(--ui-font-size)')
    expect(title).toContain('font-weight: 400')
    // Judul tidak boleh melar: toolbar yang didorong `margin-left: auto`, bukan judul.
    expect(title).not.toContain('flex: 1')
    // Block host with min-width 0, so a narrow header can shrink the toolbar (nodeToolbar.overflow).
    expect(chrome).toContain('.node-toolbar { display: block; min-width: 0; margin-left: auto; }')
    expect(chrome).not.toContain('.node-toolbar__count')
    expect(chrome).not.toContain('.pane-split-btns')
    // Tombol header memakai `vscode-toolbar-button`; kelas status lama dan merah "danger" sudah tidak ada.
    expect(chrome).not.toContain('.icon-btn {')
    expect(chrome).not.toContain('.node-toolbar__danger')
    expect(chrome).toContain(".node-toolbar vscode-toolbar-button[aria-disabled='true']")
    expect(chrome).toContain('border-radius: 50%')
  })

  it('has no gradients and no radius above the widget radius (8px)', () => {
    expect(chrome).not.toContain('gradient')
    expect(chrome).toContain('--nc-radius: 3px')
    expect(chrome).toContain('--nc-radius-widget: 8px')
    expect(chrome).not.toContain('--radius-node')
    expect(chrome).not.toContain('--shadow-node')
  })

  it('marks the selected node as the active tab by its header only, never a focus-border frame', () => {
    const decl = (sel: string) => chrome.match(new RegExp(`\\${sel}\\s*\\{([^}]*)\\}`))?.[1] ?? ''
    expect(decl('.term-node--selected')).not.toContain('--nc-border')
    expect(chrome).toContain('.term-node--selected .node-header')
    expect(chrome).toContain('--nc-focus: var(--vscode-focusBorder')
  })

  it('styles the status chip without text-transform (nodeterm labels are literal)', () => {
    const chip = chrome.slice(chrome.indexOf('.node-status {'), chrome.indexOf('@keyframes nt-pulse'))
    expect(chip).toContain('font-size: var(--ui-font-size-label)')
    expect(chip).toContain('font-weight: 400')
    expect(chip).not.toContain('letter-spacing')
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
      '.pane-host', '.pane--active', '.pane-divider',
      '.node-header', '.node-title--edit', '.node-swatch', '.node-swatch-pop',
      '.node-icon', '.node-description',
      '.node-find__field', '.node-find__actions',
      '.node-body', '.term-node--collapsed',
      '.usage-pill', '.usage-pill__label', '.usage-pill__minibar', '.usage-pill__fill',
      '.node-comments', '.node-comments__header', '.node-comments__composer', '.node-comments__input', '.node-comments__submit',
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
    // Satu sumber lebar rail: `sessions-panel.css` membaca token ini.
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
    const modes = dock.slice(dock.indexOf('.dock__modes {'), dock.indexOf(".dock-btn[aria-pressed='true']"))
    expect(modes).toContain('flex-direction: column')
    // Dimensi 48x48 + indikator 2px datang dari `.vscode-activity-bar__item` (kelas bersama).
    expect(dock).not.toContain('.dock-btn {')
    expect(dock).toContain(".dock-btn[aria-pressed='true']")
    // VS Code: toggle bukan tab — tanpa marker aktif, warna idle seragam dengan item bar.
    expect(dock).not.toContain('--vscode-activityBar-activeBorder')
    expect(modes).toContain('color: var(--vscode-activityBar-inactiveForeground)')
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
