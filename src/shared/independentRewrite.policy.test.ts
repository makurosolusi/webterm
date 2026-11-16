import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Files rewritten from documented behavior; none may carry a "copied/ported from elsewhere" marker.
const REWRITTEN = [
  'src/shared/fsLimits.ts',
  'src/shared/claudeLaunch/shellQuote.ts',
  'src/shared/workspace.capabilities.ts',
  'src/shared/workspace.agents.ts',
  'src/server/contextLinkTranscript.ts',
  'src/server/contextLinkRender.ts',
]
const ATTRIBUTION_MARKER = /\bported\b|\bporting\b|port dari|copied from|\bdiport\b|verbatim/i
const root = join(__dirname, '..', '..')

describe('rewritten server/shared files carry no attribution marker', () => {
  it.each(REWRITTEN)('%s', (rel) => {
    const lines = readFileSync(join(root, rel), 'utf8').split('\n')
    const hits = lines.filter((l) => ATTRIBUTION_MARKER.test(l))
    expect(hits).toEqual([])
  })
})
