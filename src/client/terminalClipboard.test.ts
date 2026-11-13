/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/xterm'
import { osc52Clipboard } from './terminalClipboard'

const setup = () => {
  const term = new Terminal()
  const copied: string[] = []
  const replies: string[] = []
  term.loadAddon(osc52Clipboard((t) => copied.push(t)))
  term.onData((d) => replies.push(d))
  const write = (s: string) => new Promise<void>((r) => term.write(s, r))
  return { term, copied, replies, write }
}

describe('OSC 52 clipboard', () => {
  it('an app copy (tmux / Claude Code) lands in the clipboard', async () => {
    const { copied, write } = setup()
    await write('\x1b]52;c;aGVsbG8gd29ybGQ=\x07') // "hello world"
    await write('\x1b]52;;bXVsdGk=\x07') // tmux may send an empty selection
    expect(copied).toEqual(['hello world', 'multi'])
  })

  it('a read request never reveals the clipboard', async () => {
    const { copied, replies, write } = setup()
    await write('\x1b]52;c;?\x07')
    await new Promise((r) => setTimeout(r, 0))
    expect(copied).toEqual([])
    // The addon answers, but with nothing in it.
    expect(replies.join('')).toBe('\x1b]52;c;\x07')
  })

  it('bad base64 does not wipe the clipboard', async () => {
    const { copied, write } = setup()
    await write('\x1b]52;c;!!not-base64!!\x07')
    expect(copied).toEqual([])
  })
})
