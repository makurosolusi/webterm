import { describe, expect, it, vi } from 'vitest'

// Before any src/server import resolves: never touch the real data dir.
await vi.hoisted(async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  process.env.WEBTERM_DATA_DIR ??= fs.mkdtempSync(`${os.tmpdir()}/wt-setup-data-`)
})

const { nextSettingsDocument, parseStored } = await import('./settingsStore')
const { backfillSetup } = await import('./setupBackfill')

/** In-memory settings row driven by the real store logic (same path as Db.saveSettings). */
function memoryStore(initial: string | null, existingInstall: boolean) {
  let row = initial
  const deps = {
    storedJson: () => row,
    save: (patch: unknown) => { row = JSON.stringify(nextSettingsDocument(row, patch).doc) },
    existingInstall: () => existingInstall,
    now: () => 1_700_000_000_000,
  }
  return { deps, settings: () => parseStored(row) }
}

describe('backfillSetup', () => {
  it('existing install (workspace or saved provider) is marked complete, steps empty', () => {
    const s = memoryStore('{"fontSize":15}', true)
    expect(backfillSetup(s.deps)).toBe('completed')
    expect(s.settings().setup).toEqual({ completedAt: 1_700_000_000_000, steps: {} })
    expect(s.settings().fontSize).toBe(15)
  })

  it('fresh install stays incomplete, but the decision is stored', () => {
    const s = memoryStore(null, false)
    expect(backfillSetup(s.deps)).toBe('fresh')
    expect(s.settings().setup).toEqual({ completedAt: null, steps: {} })
    expect(s.deps.storedJson()).toContain('"setup"')
  })

  it('is one-time: a later boot with a workspace does not complete a fresh install', () => {
    const s = memoryStore(null, false)
    backfillSetup(s.deps)
    const later = { ...s.deps, existingInstall: () => true }
    expect(backfillSetup(later)).toBe('skipped')
    expect(s.settings().setup.completedAt).toBeNull()
  })

  it('is idempotent and keeps wizard progress already stored', () => {
    const stored = JSON.stringify({ setup: { completedAt: null, steps: { claude: 'done' } } })
    const s = memoryStore(stored, true)
    expect(backfillSetup(s.deps)).toBe('skipped')
    expect(backfillSetup(s.deps)).toBe('skipped')
    expect(s.deps.storedJson()).toBe(stored)
  })

  it('a corrupt row counts as never decided', () => {
    const s = memoryStore('{not json', true)
    expect(backfillSetup(s.deps)).toBe('completed')
    expect(s.settings().setup.completedAt).toBe(1_700_000_000_000)
  })
})
