import { describe, expect, it } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { binaryOnPath } from './binaryOnPath'

describe('binaryOnPath', () => {
  it('finds an executable only in a directory listed in the given PATH', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bop-'))
    try {
      writeFileSync(join(dir, 'tool-x'), '#!/bin/sh\n')
      chmodSync(join(dir, 'tool-x'), 0o755)
      writeFileSync(join(dir, 'plain'), 'data')
      chmodSync(join(dir, 'plain'), 0o644)
      const path = ['/nonexistent-dir', dir].join(delimiter)
      expect(binaryOnPath('tool-x', path)).toBe(true)
      expect(binaryOnPath('plain', path)).toBe(false)
      expect(binaryOnPath('missing', path)).toBe(false)
      expect(binaryOnPath('tool-x', '')).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('defaults to process.env.PATH', () => {
    expect(binaryOnPath('definitely-not-a-real-binary-xyz')).toBe(false)
  })
})
