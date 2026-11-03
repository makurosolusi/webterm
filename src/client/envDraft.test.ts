// Logika murni draft + partisi section (ENV-03).
import { describe, expect, it } from 'vitest'
import {
  buildChange, dangerousDirtyLabels, dropSent, entryMatches, isChanged, matchesQuickFilter, partitionEntries,
  reconcileDraft, valueOfKey, withDraft,
} from './envDraft'
import { baseState, mkEntry, mkState } from './envTestFixtures'

describe('draft', () => {
  it('withDraft drops the key when value equals the server value', () => {
    const d = withDraft(new Map(), 'A', 'on', 'off')
    expect([...d]).toEqual([['A', 'on']])
    expect(withDraft(d, 'A', 'off', 'off').size).toBe(0)
  })

  it('reconcileDraft keeps differing drafts, drops equal and unknown keys', () => {
    const entries = [mkEntry({ key: 'A', value: 'off' }), mkEntry({ key: 'B', value: 'x', kind: 'string' })]
    const d = new Map([['A', 'on'], ['B', 'x'], ['GONE', 'v']])
    expect([...reconcileDraft(d, entries)]).toEqual([['A', 'on']])
  })

  it('dropSent removes only drafts still equal to what was sent', () => {
    const d = new Map([['A', 'on'], ['B', 'edited-again']])
    expect([...dropSent(d, { A: 'on', B: 'old' })]).toEqual([['B', 'edited-again']])
  })

  it('buildChange puts all drafts in one set body', () => {
    expect(buildChange(new Map([['A', '1'], ['B', '2']]))).toEqual({ set: { A: '1', B: '2' } })
  })

  it('valueOfKey prefers draft, unknown key is undefined, secret maps to on/empty without a value', () => {
    const entries = [
      mkEntry({ key: 'A', value: 'off' }),
      mkEntry({ key: 'S1', kind: 'secret', secretSet: true }),
      mkEntry({ key: 'S2', kind: 'secret', secretSet: false }),
    ]
    const d = new Map([['A', 'on']])
    expect(valueOfKey(entries, d, 'A')).toBe('on')
    expect(valueOfKey(entries, new Map(), 'A')).toBe('off')
    expect(valueOfKey(entries, d, 'NOPE')).toBeUndefined()
    expect(valueOfKey(entries, d, 'S1')).toBe('on')
    expect(valueOfKey(entries, d, 'S2')).toBe('')
  })

  it('dangerousDirtyLabels lists only dirty dangerous entries', () => {
    const entries = [mkEntry({ key: 'A', dangerous: true, label: 'Bahaya A' }), mkEntry({ key: 'B', dangerous: true, label: 'Bahaya B' }), mkEntry({ key: 'C' })]
    expect(dangerousDirtyLabels(entries, ['A', 'C'])).toEqual(['Bahaya A'])
  })
})

describe('filters', () => {
  const draft = new Map<string, string>()
  it('isChanged: override differing from default, or a draft; default source is not changed', () => {
    expect(isChanged(mkEntry({ key: 'A', source: 'override', value: 'on', default: 'off' }), draft)).toBe(true)
    expect(isChanged(mkEntry({ key: 'A', source: 'override', value: 'off', default: 'off' }), draft)).toBe(false)
    expect(isChanged(mkEntry({ key: 'A', source: 'default', value: 'x', default: 'y' }), draft)).toBe(false)
    expect(isChanged(mkEntry({ key: 'A' }), new Map([['A', 'on']]))).toBe(true)
    expect(isChanged(mkEntry({ key: 'S', kind: 'secret', source: 'override' }), draft)).toBe(true)
  })

  it('matchesQuickFilter covers restart and dangerous', () => {
    const e = mkEntry({ key: 'A', pendingRestart: true, dangerous: true })
    expect(matchesQuickFilter(e, 'restart', draft)).toBe(true)
    expect(matchesQuickFilter(e, 'dangerous', draft)).toBe(true)
    expect(matchesQuickFilter(mkEntry({ key: 'B' }), 'restart', draft)).toBe(false)
    expect(matchesQuickFilter(mkEntry({ key: 'B' }), undefined, draft)).toBe(true)
  })

  it('entryMatches searches label, KEY, description and section case-insensitively', () => {
    const e = mkEntry({ key: 'WEBTERM_X', label: 'Fitur Kirim', description: 'mengirim pesan', section: 'Telegram' })
    for (const q of ['kirim', 'webterm_x', 'pesan', 'telegram', 'fitur telegram']) expect(entryMatches(e, q)).toBe(true)
    expect(entryMatches(e, 'zzz')).toBe(false)
    expect(entryMatches(e, '')).toBe(true)
  })
})

describe('partitionEntries', () => {
  it('splits by audience, groups by section, orders by group order', () => {
    const s = baseState()
    const p = partitionEntries(s.entries, s.groups, false)
    expect(p.main.map((x) => x.title)).toEqual(['Sec A'])
    expect(p.main[0]!.entries.map((x) => x.key)).toEqual(['K_ONE', 'K_TWO', 'K_DANGER', 'K_SECRET'])
    expect(p.advanced.map((x) => x.title)).toEqual(['Sec B'])
    expect(p.channels).toEqual([])
  })

  it('orders sections by group order, unknown groups last', () => {
    const st = mkState([
      mkEntry({ key: 'A', group: 'zzz', section: 'Unknown' }),
      mkEntry({ key: 'B', group: 'g2', section: 'Second' }),
      mkEntry({ key: 'C', group: 'g1', section: 'First' }),
    ])
    expect(partitionEntries(st.entries, st.groups, false).main.map((x) => x.title)).toEqual(['First', 'Second', 'Unknown'])
  })

  it('pulls owner channels out only when channelsOwned', () => {
    const entries = [mkEntry({ key: 'T', owner: 'channels' }), mkEntry({ key: 'U' })]
    const on = partitionEntries(entries, [], true)
    expect(on.channels.map((e) => e.key)).toEqual(['T'])
    expect(on.main[0]!.entries.map((e) => e.key)).toEqual(['U'])
    const off = partitionEntries(entries, [], false)
    expect(off.channels).toEqual([])
    expect(off.main[0]!.entries.map((e) => e.key)).toEqual(['T', 'U'])
  })
})
