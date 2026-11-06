import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const clientRoot = path.dirname(fileURLToPath(import.meta.url))

// Why: the production CSS minifier merges `transform: none !important; translate: none !important`
// into `transform:translate(0,0)!important`, dropping the `translate` PROPERTY reset. Tailwind v4
// `translate-x-*` utilities use that property, so the reset silently stops working in prod only
// (Settings rendered half off-screen). Override the utility via className/tailwind-merge instead.
describe('css translate reset policy', () => {
  it('no src/client css cancels a Tailwind translate utility with `translate: none !important`', () => {
    const offenders = (readdirSync(clientRoot, { recursive: true }) as string[])
      .filter((f) => f.endsWith('.css'))
      .filter((f) => /(^|[;{\s])translate\s*:\s*none\s*!important/.test(readFileSync(path.join(clientRoot, f), 'utf8')))
    expect(offenders).toEqual([])
  })
})
