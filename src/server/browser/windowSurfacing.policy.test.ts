// Scanner: no browser source may mention a window-surfacing CDP method outside the guard's own deny list.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const BANNED = /activateTarget|bringToFront|setWindowBounds/
const sources = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => {
  const p = join(d, e.name)
  if (e.isDirectory()) return sources(p)
  return e.name.endsWith('.ts') && !/\.(test|testkit)\.ts$/.test(e.name) && e.name !== 'cdp.windowGuard.ts' ? [p] : []
})

describe('window surfacing is banned (docs/decisions/canvas-containment.md)', () => {
  it('no src/server/browser source references a surfacing CDP method', () => {
    const files = sources(__dirname)
    expect(files.length).toBeGreaterThan(10)
    expect(files.filter((f) => BANNED.test(readFileSync(f, 'utf8')))).toEqual([])
  })
})
