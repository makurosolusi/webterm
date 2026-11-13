import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { contextFillColor, USAGE_RED, USAGE_YELLOW, USAGE_GREEN } from './UsagePill'
import { NODE_COLORS } from './NodeColorSwatch'
import { termNodeClass, UNTITLED } from './NodeChrome'

describe('contextFillColor', () => {
  it('> 85 → red', () => { expect(contextFillColor(90)).toBe(USAGE_RED) })
  it('86 is red (strictly greater than 85)', () => { expect(contextFillColor(86)).toBe(USAGE_RED) })
  it('85 is NOT red → yellow (>=60 band)', () => { expect(contextFillColor(85)).toBe(USAGE_YELLOW) })
  it('60 boundary → yellow', () => { expect(contextFillColor(60)).toBe(USAGE_YELLOW) })
  it('59 → green', () => { expect(contextFillColor(59)).toBe(USAGE_GREEN) })
  it('0 → green', () => { expect(contextFillColor(0)).toBe(USAGE_GREEN) })
})
// The header chip's words now come from the shared model (sessionStatus.model.test.tsx pins waiting
// vs blocked: "Turn ended" is calm Idle, "Needs you" is attention); NodeStatusChip.test.tsx pins the chip.

describe('termNodeClass', () => {
  it('node polos hanya .term-node', () => {
    expect(termNodeClass({})).toBe('term-node')
  })
  it('selected dan collapsed memakai modifier BEM yang sudah dipakai AgentNode', () => {
    expect(termNodeClass({ selected: true, collapsed: true }))
      .toBe('term-node term-node--selected term-node--collapsed')
  })
  it('working/attention TANPA prefiks — selector glow :has() nodeterm mencocokkan kelas polos', () => {
    expect(termNodeClass({ status: 'working' })).toBe('term-node working')
    expect(termNodeClass({ status: 'blocked' })).toBe('term-node attention')
  })
  it('turn ended (waiting) is calm idle: no ring, no halo', () => {
    expect(termNodeClass({ status: 'waiting' })).toBe('term-node')
  })
  it('done tidak menyalakan glow apa pun', () => {
    expect(termNodeClass({ status: 'done' })).toBe('term-node')
  })
  it('judul kosong jatuh ke fallback nodeterm', () => {
    expect(UNTITLED).toBe('Untitled')
  })
})

describe('NODE_COLORS', () => {
  it('is a non-empty palette of hex strings', () => {
    expect(NODE_COLORS.length).toBeGreaterThan(0)
    for (const c of NODE_COLORS) expect(c).toMatch(/^#[0-9a-f]{6}$/i)
  })
})

describe('node-chrome.css: status chip tones', () => {
  // Without layout in vitest the stylesheet's SOURCE is what can be checked: each tone of the shared
  // model has a rule, attention and working use different tokens, and only attention pulses.
  const chrome = readFileSync(fileURLToPath(new URL('./node-chrome.css', import.meta.url)), 'utf8')
  const decl = (sel: string) => chrome.match(new RegExp(`\\${sel}\\s*\\{([^}]*)\\}`))?.[1] ?? ''

  it('attention, working, error and unread each have a colour; attention and working differ', () => {
    expect(decl('.node-status--attention')).toContain('var(--state-attention)')
    expect(decl('.node-status--working')).toContain('var(--state-working)')
    expect(decl('.node-status--error')).toContain('--vscode-errorForeground')
    expect(decl('.node-status--unread')).toContain('var(--accent)')
  })

  it('only the attention chip pulses', () => {
    expect(chrome).toContain('.node-status--attention .codicon { animation:')
    expect(chrome).not.toMatch(/\.node-status--(working|idle|error|unread|muted) \.codicon \{ animation:/)
  })

  it('has no turn-ended ring: waiting is calm idle', () => {
    expect(chrome).not.toContain('.term-node.waiting')
  })

  it('the node colour is an edge accent on the header, not a dot', () => {
    expect(decl('.node-header')).toContain('var(--nc-node-color')
    expect(chrome).not.toContain('.node-swatch__dot')
  })

  it('the agent body stacks terminal and lifecycle bar so the bar never covers the last rows', () => {
    expect(decl('.node-body--stack')).toContain('flex-direction: column')
    expect(decl('.node-body__term')).toMatch(/flex: 1;[\s\S]*min-height: 0/)
  })
})

describe('node-chrome.css — ongkos compositing', () => {
  // Seluruh sheet ini menata isi viewport React Flow, yang hidup di bawah `transform`. Satu
  // `will-change` di sini mempromosikan tiap node jadi compositing layer PERMANEN (bukan hanya
  // selama animasi), dan layer composited di dalam parent yang di-transform adalah penyebab kedip
  // repaint di Chromium. Animasi opacity tidak butuh hint itu — browser mempromosikannya sendiri
  // selagi berjalan. Jadi: nol `will-change` di sheet ini, glow status termasuk.
  it('tidak memakai will-change sama sekali', () => {
    const chrome = readFileSync(fileURLToPath(new URL('./node-chrome.css', import.meta.url)), 'utf8')
    expect(chrome).toContain('animation: nt-working-glow')
    expect(chrome).toContain('animation: nt-attention-glow')
    // Komentar dibuang dulu: yang dilarang itu DEKLARASI-nya, sedangkan komentar di sheet itu
    // memang menyebut `will-change` untuk menjelaskan kenapa ia tidak ada.
    expect(chrome.replace(/\/\*[\s\S]*?\*\//g, '')).not.toContain('will-change')
  })
})
