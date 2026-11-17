import { describe, expect, it } from 'vitest'
import {
  WORKSPACE_HUES, WORKSPACE_SHADES, backfillWorkspaceHue, describeWorkspaceColor, isWorkspaceHue, isWorkspaceShade,
  pickWorkspaceColor, workspaceColorVar,
} from './workspaceColor'

describe('pickWorkspaceColor', () => {
  it('avoids hues already used', () => {
    const used = WORKSPACE_HUES.filter((h) => h !== 'teal' && h !== 'pink')
    for (const r of [0, 0.5, 0.99]) expect(['teal', 'pink']).toContain(pickWorkspaceColor(used, () => r))
  })
  it('is deterministic for an injected rand', () => {
    expect(pickWorkspaceColor([], () => 0)).toBe('red')
    expect(pickWorkspaceColor([], () => 0.999)).toBe('slate')
    expect(pickWorkspaceColor(['red'], () => 0)).toBe('orange')
  })
  it('falls back to the least used hues when all 12 are taken', () => {
    const used = [...WORKSPACE_HUES, ...WORKSPACE_HUES.filter((h) => h !== 'blue')]
    expect(pickWorkspaceColor(used, () => 0.3)).toBe('blue')
  })
  it('ignores unknown and empty values in `used`', () => {
    expect(pickWorkspaceColor(['#ff0000', null, undefined, ''], () => 0)).toBe('red')
  })
})

describe('palette helpers', () => {
  it('has 12 hues and 3 shades, validated exactly', () => {
    expect(WORKSPACE_HUES.length).toBe(12)
    expect(WORKSPACE_SHADES.length).toBe(3)
    expect(isWorkspaceHue('indigo')).toBe(true)
    expect(isWorkspaceHue('#fff')).toBe(false)
    expect(isWorkspaceShade('vivid')).toBe(true)
    expect(isWorkspaceShade('neon')).toBe(false)
  })
  it('maps ids to tokens and falls back to slate/default', () => {
    expect(workspaceColorVar('teal', 'soft')).toBe('var(--ws-teal-soft)')
    expect(workspaceColorVar(undefined, undefined)).toBe('var(--ws-slate-default)')
    expect(describeWorkspaceColor('blue', 'vivid')).toBe('blue vivid')
    expect(describeWorkspaceColor(undefined, undefined)).toBe('unset')
  })
  it('backfills the same hue for the same id every time', () => {
    expect(backfillWorkspaceHue('abc')).toBe(backfillWorkspaceHue('abc'))
    expect(isWorkspaceHue(backfillWorkspaceHue('some-uuid'))).toBe(true)
  })
})
