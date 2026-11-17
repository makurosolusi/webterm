// The 2026-11-17 Bypass default: a stored Ask/Auto moves once; project overrides and a later explicit choice stay.
import { describe, expect, it } from 'vitest'
import { approvalLevelOf } from '../shared/settings.approvalLevel'
import { mergeSettings } from '../shared/settings'
import { approvalLevelFor } from '../shared/settings.projectApprovalLevels'
import { nextSettingsDocument } from './settingsStore'
import { APPROVAL_DEFAULT_MARKER, migrateApprovalDefault } from './approvalDefaultMigration'

/** In-memory stand-in for the settings row + `app` flags, saving through the real patch pipeline. */
function store(initial: Record<string, unknown> | null) {
  let json: string | null = initial ? JSON.stringify(initial) : null
  const flags = new Map<string, string>()
  const deps = {
    getFlag: (k: string) => flags.get(k) ?? null,
    setFlag: (k: string, v: string) => void flags.set(k, v),
    settings: () => mergeSettings(json ? (JSON.parse(json) as unknown) : {}),
    save: (p: object) => { json = JSON.stringify(nextSettingsDocument(json, p).doc) },
  }
  return { deps, flags, level: () => approvalLevelOf(deps.settings()), current: () => deps.settings() }
}

describe('migrateApprovalDefault', () => {
  it('moves a stored Auto or Ask to Bypass once, and says so', () => {
    for (const stored of [{ skipApprovals: false, claudePermissionMode: 'auto' }, { skipApprovals: false, claudePermissionMode: 'manual' }]) {
      const s = store(stored)
      expect(migrateApprovalDefault(s.deps)).toBe('moved')
      expect(s.level()).toBe('never')
      expect(s.flags.get(APPROVAL_DEFAULT_MARKER)).toBe('moved')
    }
  })

  it('is idempotent: a later explicit Ask is final', () => {
    const s = store({ skipApprovals: false })
    expect(migrateApprovalDefault(s.deps)).toBe('moved')
    s.deps.save({ agentApprovalLevel: 'always' })
    expect(migrateApprovalDefault(s.deps)).toBe('skipped')
    expect(s.level()).toBe('always')
  })

  it('fresh install and stored Bypass change nothing, but are marked', () => {
    for (const initial of [null, {}, { skipApprovals: true }]) {
      const s = store(initial)
      expect(migrateApprovalDefault(s.deps)).toBe('marked')
      expect(s.level()).toBe('never')
    }
  })

  it('leaves every per-project override untouched', () => {
    const s = store({ skipApprovals: false, projectApprovalLevels: { w1: 'always', w2: 'risky' } })
    migrateApprovalDefault(s.deps)
    const cur = s.current()
    expect(cur.projectApprovalLevels).toEqual({ w1: 'always', w2: 'risky' })
    expect(approvalLevelFor(cur, 'w1')).toBe('always')
    expect(approvalLevelFor(cur, 'w3')).toBe('never')
  })

  it('a failed save leaves the marker unset so the next boot retries', () => {
    const s = store({ skipApprovals: false })
    const failing = { ...s.deps, save: () => { throw new Error('disk full') } }
    expect(() => migrateApprovalDefault(failing)).toThrow('disk full')
    expect(s.flags.size).toBe(0)
  })
})
