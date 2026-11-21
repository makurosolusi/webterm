import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

// The annotator never leaves the browser: no network, no new tab/window, no navigation (see canvas-containment.md).
const FORBIDDEN = [/\bfetch\(/, /XMLHttpRequest/, /WebSocket/, /sendBeacon/, /window\.open/, /target="_blank"/, /\blocation\./]
const dir = dirname(fileURLToPath(import.meta.url))
const sources = readdirSync(dir).filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))

describe('screenshot sources stay local', () => {
  test('there are sources to scan', () => expect(sources.length).toBeGreaterThan(5))
  test.each(sources)('%s has no network, window.open, _blank or location use', (f) => {
    const src = readFileSync(join(dir, f), 'utf8')
    for (const re of FORBIDDEN) expect(src, `${f} matches ${re}`).not.toMatch(re)
  })
})
