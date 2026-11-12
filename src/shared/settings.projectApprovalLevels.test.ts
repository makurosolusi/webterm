import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, mergeSettings } from './settings'
import { applySettingsPatch } from './settings.patch'
import {
  approvalLevelChanges, approvalLevelFor, approvalModeName, claudeModeFor, normalizeProjectApprovalLevels,
  projectApprovalLevelsPatchErrors, skipApprovalsFor,
} from './settings.projectApprovalLevels'

const AUTO = { skipApprovals: false, claudePermissionMode: 'acceptEdits' as const, projectApprovalLevels: { w1: 'never' as const, w2: 'always' as const } }

describe('approvalLevelFor', () => {
  it('a workspace override wins; unset or unknown workspace = the global level', () => {
    expect(approvalLevelFor(AUTO, 'w1')).toBe('never')
    expect(approvalLevelFor(AUTO, 'w2')).toBe('always')
    expect(approvalLevelFor(AUTO, 'w3')).toBe('risky')
    expect(approvalLevelFor(AUTO)).toBe('risky')
    expect(approvalLevelFor({ ...AUTO, skipApprovals: true }, 'w3')).toBe('never')
    expect(approvalLevelFor({ ...AUTO, skipApprovals: true }, 'w2')).toBe('always') // Ask in one project under a global Danger
  })

  it('derived: skip, claude mode (global keeps its raw mode), user-facing names', () => {
    expect(skipApprovalsFor(AUTO, 'w1')).toBe(true)
    expect(skipApprovalsFor(AUTO, 'w3')).toBe(false)
    expect(claudeModeFor(AUTO, 'w1')).toBe('bypassPermissions')
    expect(claudeModeFor(AUTO, 'w2')).toBe('manual')
    expect(claudeModeFor(AUTO, 'w3')).toBe('acceptEdits')
    expect(claudeModeFor({ ...AUTO, projectApprovalLevels: { w4: 'risky' } }, 'w4')).toBe('auto')
    expect(['always', 'risky', 'never'].map((l) => approvalModeName(l as 'always'))).toEqual(['ask', 'auto', 'danger'])
  })
})

describe('projectApprovalLevels in settings', () => {
  it('defaults to {}, normalizes on load, patches per entry (null deletes)', () => {
    expect(DEFAULT_SETTINGS.projectApprovalLevels).toEqual({})
    expect(mergeSettings({ projectApprovalLevels: { w1: 'never', w2: 'bogus', '': 'risky' } }).projectApprovalLevels).toEqual({ w1: 'never' })
    expect(normalizeProjectApprovalLevels([])).toEqual({})
    const doc = applySettingsPatch({ projectApprovalLevels: { w1: 'never', w2: 'risky' } }, { projectApprovalLevels: { w1: null, w3: 'always' } })
    expect(doc.projectApprovalLevels).toEqual({ w2: 'risky', w3: 'always' })
  })

  it('a patch with an unknown level or a bad shape is refused, not dropped', () => {
    expect(projectApprovalLevelsPatchErrors(undefined)).toEqual([])
    expect(projectApprovalLevelsPatchErrors({ w1: 'never', w2: null })).toEqual([])
    expect(projectApprovalLevelsPatchErrors({ w1: 'yolo' })).toEqual([{ index: 0, field: 'projectApprovalLevels.entry', code: 'invalid_level' }])
    expect(projectApprovalLevelsPatchErrors('never')).toEqual([{ index: -1, field: 'projectApprovalLevels', code: 'not_object' }])
  })

  it('approvalLevelChanges: global move, then each override set or cleared, with effective from/to', () => {
    const prev = { skipApprovals: false, claudePermissionMode: 'auto' as const, projectApprovalLevels: { w1: 'always' as const } }
    const next = { skipApprovals: true, claudePermissionMode: 'auto' as const, projectApprovalLevels: { w2: 'risky' as const } }
    expect(approvalLevelChanges(prev, next)).toEqual([
      { scope: 'global', from: 'risky', to: 'never' },
      { scope: 'workspace', workspaceId: 'w1', from: 'always', to: 'never' },
      { scope: 'workspace', workspaceId: 'w2', from: 'risky', to: 'risky' },
    ])
  })
})
