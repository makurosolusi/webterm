// Node environment on purpose: `@xterm/addon-clipboard`'s UMD bundle reads `self` at module
// evaluation, so a static import of it anywhere on TerminalCore's chain broke every node-env test
// that reaches a terminal component (agentToolbar.test.ts via AgentNode).
import { describe, expect, it } from 'vitest'

describe('terminal import chain in a node environment', () => {
  it('has no browser global to touch', () => {
    expect(typeof (globalThis as { self?: unknown }).self).toBe('undefined')
  })

  it('terminalClipboard imports without loading the addon', async () => {
    await expect(import('./terminalClipboard')).resolves.toHaveProperty('loadOsc52Clipboard')
  })

  it('TerminalCore imports', async () => {
    await expect(import('./TerminalCore')).resolves.toBeDefined()
  })
})
