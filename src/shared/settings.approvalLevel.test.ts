// Approval level <-> the runtime keys, both ways, plus the one-line default.
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, mergeSettings } from './settings'
import { applySettingsPatch } from './settings.patch'
import { APPROVAL_LEVELS, DEFAULT_APPROVAL_LEVEL, approvalClassifierSwitch, approvalLevelOf, approvalLevelPatch } from './settings.approvalLevel'

describe('approval level', () => {
  it('writes the runtime keys and reads back the same level', () => {
    expect(approvalLevelPatch('never')).toEqual({ skipApprovals: true })
    expect(approvalLevelPatch('risky')).toEqual({ skipApprovals: false, claudePermissionMode: 'auto', hookReplyApprovals: true })
    expect(approvalLevelPatch('always')).toEqual({ skipApprovals: false, claudePermissionMode: 'manual', hookReplyApprovals: true })
    for (const l of APPROVAL_LEVELS) expect(approvalLevelOf({ ...DEFAULT_SETTINGS, ...approvalLevelPatch(l) })).toBe(l)
  })

  it('reads any older combination of keys as a level', () => {
    expect(approvalLevelOf({ skipApprovals: true, claudePermissionMode: 'manual' })).toBe('never')
    expect(approvalLevelOf({ skipApprovals: false, claudePermissionMode: 'acceptEdits' })).toBe('risky')
    expect(approvalLevelOf({ skipApprovals: false, claudePermissionMode: 'manual' })).toBe('always')
  })

  it('the default comes from the one constant and is consistent with its keys', () => {
    // Owner decision 2026-11-17: Bypass by default (was Auto).
    expect(DEFAULT_APPROVAL_LEVEL).toBe('never')
    expect(DEFAULT_SETTINGS).toMatchObject({ skipApprovals: true, claudePermissionMode: 'auto', hookReplyApprovals: true })
    expect(DEFAULT_SETTINGS.agentApprovalLevel).toBe(DEFAULT_APPROVAL_LEVEL)
    expect(approvalLevelOf(DEFAULT_SETTINGS)).toBe(DEFAULT_APPROVAL_LEVEL)
  })

  it('a stored explicit choice is kept; only an unset value gets the default', () => {
    expect(mergeSettings({ skipApprovals: true }).agentApprovalLevel).toBe('never')
    expect(mergeSettings({ skipApprovals: false, claudePermissionMode: 'manual' }).agentApprovalLevel).toBe('always')
    expect(mergeSettings({}).agentApprovalLevel).toBe('never')
  })

  it('a patch is written as the keys; a stored level is never trusted over them', () => {
    const doc = applySettingsPatch({ skipApprovals: true }, { agentApprovalLevel: 'always' })
    expect(mergeSettings(doc)).toMatchObject({ skipApprovals: false, claudePermissionMode: 'manual', agentApprovalLevel: 'always' })
    expect(mergeSettings({ skipApprovals: true, agentApprovalLevel: 'always' }).agentApprovalLevel).toBe('never')
    expect(applySettingsPatch({ skipApprovals: true }, { agentApprovalLevel: 'bogus' })).toEqual({ skipApprovals: true })
  })

  it('auto-approvers follow risky / always and are left alone by never', () => {
    expect(approvalClassifierSwitch('risky')).toEqual({ central: true, permissions: true })
    expect(approvalClassifierSwitch('always')).toEqual({ central: false, permissions: false })
    expect(approvalClassifierSwitch('never')).toBeNull()
  })
})
