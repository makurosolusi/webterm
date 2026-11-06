import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/** Guards the VS Code panel metrics the two converted panels depend on. */
describe('bottom panel metrics', () => {
  const surface = readFileSync('src/client/inboxPanelSurface.css', 'utf8')

  it('docks a 35px title bar over the panel background', () => {
    expect(surface).toMatch(/--bottom-panel-title-h:\s*35px/)
    expect(surface).toMatch(/background:\s*var\(--vscode-panel-background/)
    expect(surface).toMatch(/\.vscode-bottom-panel\s*\{[^}]*position:\s*absolute/s)
  })

  it('uses one 22px row token for both list panes', () => {
    expect(surface).toContain('--bottom-panel-row-h: var(--list-row-h, 22px)')
    expect(readFileSync('src/client/inbox.css', 'utf8')).toContain(
      'min-height: var(--bottom-panel-row-h, 22px)'
    )
    expect(readFileSync('src/client/chat/chat.css', 'utf8')).toContain(
      'height: var(--bottom-panel-row-h, 22px)'
    )
  })
})
