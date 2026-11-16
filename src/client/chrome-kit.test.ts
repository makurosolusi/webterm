import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { contextFillColor, USAGE_RED, USAGE_YELLOW, USAGE_GREEN } from './UsagePill'
import { NODE_COLORS } from './NodeColorSwatch'
import { termNodeClass, UNTITLED } from './NodeChrome'

describe('contextFillColor bands', () => {
  it.each([
    [0, USAGE_GREEN],
    [30, USAGE_GREEN],
    [59, USAGE_GREEN],
    [60, USAGE_YELLOW],
    [72, USAGE_YELLOW],
    [85, USAGE_YELLOW],
    [86, USAGE_RED],
    [100, USAGE_RED],
  ])('%i%% uses %s', (percent, color) => {
    expect(contextFillColor(percent)).toBe(color)
  })

  it('uses three distinct colours', () => {
    expect(new Set([USAGE_GREEN, USAGE_YELLOW, USAGE_RED]).size).toBe(3)
  })
})

// The header chip's words come from the shared session-status model (sessionStatus.model.test.tsx
// pins waiting vs blocked) and NodeStatusChip.test.tsx pins the chip itself; here only the class.
describe('termNodeClass', () => {
  it('is just .term-node for a plain node', () => {
    expect(termNodeClass({})).toBe('term-node')
  })

  it('adds the selected and collapsed modifiers in that order', () => {
    expect(termNodeClass({ selected: true })).toBe('term-node term-node--selected')
    expect(termNodeClass({ collapsed: true })).toBe('term-node term-node--collapsed')
    expect(termNodeClass({ selected: true, collapsed: true })).toBe(
      'term-node term-node--selected term-node--collapsed',
    )
  })

  it('uses unprefixed status classes because the glow selectors match them with :has()', () => {
    expect(termNodeClass({ status: 'working' })).toBe('term-node working')
    expect(termNodeClass({ status: 'blocked' })).toBe('term-node attention')
  })

  it('keeps a finished or turn-ended node visually calm', () => {
    expect(termNodeClass({ status: 'waiting' })).toBe('term-node')
    expect(termNodeClass({ status: 'done' })).toBe('term-node')
  })

  it('keeps modifiers and status together', () => {
    expect(termNodeClass({ selected: true, status: 'working' })).toBe('term-node term-node--selected working')
  })

  it('falls back to "Untitled" for an empty title', () => {
    expect(UNTITLED).toBe('Untitled')
  })
})

describe('NODE_COLORS', () => {
  it('is a non-empty palette of unique hex colours', () => {
    expect(NODE_COLORS.length).toBeGreaterThan(0)
    for (const c of NODE_COLORS) expect(c).toMatch(/^#[0-9a-f]{6}$/i)
    expect(new Set(NODE_COLORS.map((c) => c.toLowerCase())).size).toBe(NODE_COLORS.length)
  })
})

const chromeCss = () =>
  readFileSync(fileURLToPath(new URL('./node-chrome.css', import.meta.url)), 'utf8')

describe('node-chrome.css: status chip tones', () => {
  // The stylesheet's SOURCE is what can be checked without layout: every tone of the shared model
  // has a rule, attention and working use different tokens, and only attention pulses.
  const chrome = chromeCss()
  const rule = (selector: string) =>
    chrome.match(new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`))?.[1] ?? ''

  it('gives attention, working, error and unread their own colour', () => {
    expect(rule('.node-status--attention')).toContain('var(--state-attention)')
    expect(rule('.node-status--working')).toContain('var(--state-working)')
    expect(rule('.node-status--error')).toContain('--vscode-errorForeground')
    expect(rule('.node-status--unread')).toContain('var(--accent)')
  })

  it('pulses the attention icon only', () => {
    expect(chrome).toContain('.node-status--attention .codicon { animation:')
    expect(chrome).not.toMatch(/\.node-status--(working|idle|error|unread|muted) \.codicon \{ animation:/)
  })

  it('draws no ring for a turn-ended node', () => {
    expect(chrome).not.toContain('.term-node.waiting')
  })

  it('shows the node colour as a header edge accent, not a dot', () => {
    expect(rule('.node-header')).toContain('var(--nc-node-color')
    expect(chrome).not.toContain('.node-swatch__dot')
  })

  it('stacks the terminal above the lifecycle bar so the bar never hides the last rows', () => {
    expect(rule('.node-body--stack')).toContain('flex-direction: column')
    expect(rule('.node-body__term')).toMatch(/flex: 1;[\s\S]*min-height: 0/)
  })
})

describe('node-chrome.css: compositing cost', () => {
  // This sheet styles content inside React Flow's transformed viewport. A `will-change` here would
  // promote every node to a permanent compositing layer, and composited layers under a transformed
  // parent cause repaint flicker in Chromium. Opacity animations are promoted by the browser only
  // while they run, so the rule is zero `will-change`, status glow included.
  it('declares will-change nowhere', () => {
    const chrome = chromeCss()
    expect(chrome).toContain('animation: nt-working-glow')
    expect(chrome).toContain('animation: nt-attention-glow')
    // Strip comments first: the sheet mentions `will-change` while explaining why it is absent.
    expect(chrome.replace(/\/\*[\s\S]*?\*\//g, '')).not.toContain('will-change')
  })
})
