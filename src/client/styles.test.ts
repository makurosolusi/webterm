import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('./styles.css', import.meta.url)), 'utf8')

describe('styles.css token & class contract', () => {
  it('defines core surface/accent/status tokens', () => {
    for (const tok of [
      '--canvas-bg: #000000',
      '--bg: #1e1e1e',
      '--panel: #282828',
      '--border: rgba(255, 255, 255, 0.1)',
      '--text: rgba(255, 255, 255, 0.85)',
      '--accent: #0a84ff',
      '--state-working: #d97757',
      '--radius-node: 10px',
      '--shadow-node: 0 8px 28px rgba(0, 0, 0, 0.4)',
      '--float-gap: 22px',
    ]) {
      expect(css).toContain(tok)
    }
  })

  it('defines key component classes used by Wave B', () => {
    for (const cls of [
      '.dock',
      '.dock-btn',
      '.dock-sep',
      '.dock-zoom',
      '.dock-flyout',
      '.dock-flyout-item',
      '.term-node',
      '.term-node--selected',
      '.node-header',
      '.node-title',
      '.node-swatch',
      '.node-status',
      '.node-status--working',
      '.node-status--waiting',
      '.node-status--blocked',
      '.node-status--done',
      '.icon-btn',
      '.minimap-dock',
      '.ws-switcher',
      '.ws-switcher-item',
      '.ws-switcher-item--active',
      '.btn',
      '.btn--accent',
      '.btn--ghost',
      '.field',
      '.panel',
    ]) {
      expect(css).toContain(cls)
    }
  })

  it('defines the working-status pulse keyframes', () => {
    expect(css).toContain('@keyframes pulse-working')
    expect(css).toContain('animation: pulse-working 1.4s ease-in-out infinite')
  })
})
