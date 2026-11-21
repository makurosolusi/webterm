import { expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

it('keeps temp dirs made by tests inside the per-run root (removed with it)', () => {
  const root = process.env.WEBTERM_TEST_ROOT
  expect(root).toBeTruthy()
  expect(mkdtempSync(`${tmpdir()}/x-`).startsWith(`${root}/tmp/`)).toBe(true)
})
