// `claudeLaunchProfiles` patch semantics (settings.patch.ts): upsert by id, tombstones delete, two pending
// patches combine in order, and the undo `before` restores edits and removes additions.
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from './settings'
import { applySettingsPatch, mergeSettingsPatches, settingsPatchBefore } from './settings.patch'

const A = { id: 'a', name: 'A', command: 'claude' } // test-only
const B = { id: 'b', name: 'B', command: 'envman -e x -- claude' } // test-only
const S = { ...DEFAULT_SETTINGS, claudeLaunchProfiles: [A, B] }

describe('claudeLaunchProfiles patch', () => {
  it('upserts by id in place, appends new ids, and only a tombstone deletes', () => {
    const edited = applySettingsPatch(S, { claudeLaunchProfiles: [{ ...A, name: 'A2' }, { id: 'c', name: 'C', command: 'claude' }] })
    expect(edited.claudeLaunchProfiles.map((p) => `${p.id}:${p.name}`)).toEqual(['a:A2', 'b:B', 'c:C'])
    expect(applySettingsPatch(S, { claudeLaunchProfiles: [] }).claudeLaunchProfiles).toEqual([A, B])
    expect(applySettingsPatch(S, { claudeLaunchProfiles: [{ id: 'a', deleted: true }] }).claudeLaunchProfiles).toEqual([B])
  })

  it('two pending patches combine in order: an add then a delete of the same id is a delete', () => {
    const p = mergeSettingsPatches({ claudeLaunchProfiles: [{ id: 'c', name: 'C', command: 'claude' }] }, { claudeLaunchProfiles: [{ id: 'c', deleted: true }, { ...A, name: 'A2' }] })
    expect(applySettingsPatch(S, p).claudeLaunchProfiles.map((x) => x.name)).toEqual(['A2', 'B'])
  })

  it('undo before: an edit restores the old entry, an addition becomes a tombstone', () => {
    const value = [{ ...A, name: 'A2' }, { id: 'c', name: 'C', command: 'claude' }]
    const before = settingsPatchBefore(S, 'claudeLaunchProfiles', value)
    expect(before).toEqual([A, { id: 'c', deleted: true }])
    const after = applySettingsPatch(S, { claudeLaunchProfiles: value })
    expect(applySettingsPatch(after, { claudeLaunchProfiles: before as never }).claudeLaunchProfiles).toEqual([A, B])
  })
})
