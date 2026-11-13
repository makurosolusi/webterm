/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/xterm'
import { loadOsc52Clipboard } from './terminalClipboard'

const setup = async () => {
  const term = new Terminal()
  const copied: string[] = []
  const replies: string[] = []
  const addon = await loadOsc52Clipboard(term, (t) => copied.push(t), () => true, 't1')
  expect(addon).toBeDefined()
  term.onData((d) => replies.push(d))
  const write = (s: string) => new Promise<void>((r) => term.write(s, r))
  return { term, copied, replies, write }
}

describe('OSC 52 clipboard', () => {
  afterEach(() => {
    vi.doUnmock('@xterm/addon-clipboard')
    vi.restoreAllMocks()
  })

  it('an app copy (tmux / Claude Code) lands in the clipboard', async () => {
    const { copied, write } = await setup()
    await write('\x1b]52;c;aGVsbG8gd29ybGQ=\x07') // "hello world"
    await write('\x1b]52;;bXVsdGk=\x07') // tmux may send an empty selection
    expect(copied).toEqual(['hello world', 'multi'])
  })

  it('a read request never reveals the clipboard', async () => {
    const { copied, replies, write } = await setup()
    await write('\x1b]52;c;?\x07')
    await new Promise((r) => setTimeout(r, 0))
    expect(copied).toEqual([])
    // The addon answers, but with nothing in it.
    expect(replies.join('')).toBe('\x1b]52;c;\x07')
  })

  it('bad base64 does not wipe the clipboard', async () => {
    const { copied, write } = await setup()
    await write('\x1b]52;c;!!not-base64!!\x07')
    expect(copied).toEqual([])
  })

  it('a terminal disposed while the addon loads never gets it', async () => {
    const term = new Terminal()
    const load = vi.spyOn(term, 'loadAddon')
    expect(await loadOsc52Clipboard(term, () => {}, () => false, 't1')).toBeUndefined()
    expect(load).not.toHaveBeenCalled()
  })

  it('a bundle that fails to load warns with the terminal id and leaves the terminal usable', async () => {
    vi.resetModules()
    vi.doMock('@xterm/addon-clipboard', () => { throw new Error('chunk 404') })
    const { loadOsc52Clipboard: load } = await import('./terminalClipboard')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const term = new Terminal()
    expect(await load(term, () => {}, () => true, 'node-7')).toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('terminal node-7: OSC 52 clipboard addon failed to load'), expect.anything())
  })
})
