// Policy (docs/decisions/settings-overhaul.md, wave 3): every boolean setting defaults to its most capable value. One
// that defaults off must be a written safeguard (SAFEGUARDS, shown in the UI), pure taste (PREFERENCES), or switch
// itself on once its dependency exists (AUTOMATIC). A new off-by-default switch fails here, naming its key.
import { describe, expect, it } from 'vitest'
import { CAPABILITIES, CAPABILITY_IDS } from '../shared/featureCapabilities'
import { DEFAULT_SETTINGS } from '../shared/settings'
import { SAFEGUARDS } from '../shared/settings.safeguards'
import { ENV_REGISTRY, specFor } from './envRegistry'

/** Off because it is taste, not capability: turning it on would not let anyone do more. */
const PREFERENCES: Readonly<Record<string, string>> = {
  copyOnSelect: 'Copying on select overwrites the clipboard; a habit, not a feature.',
  snapToGrid: 'Free placement versus snapping is taste.',
  WEBTERM_BROWSER_HEADLESS: 'Off is the more capable option: a real off-screen window that sites do not flag as a bot.',
}

/** Off until its dependency exists, then on by itself; the card names the missing step with a fix. */
const AUTOMATIC: Readonly<Record<string, string>> = {
  WEBTERM_TELEGRAM: 'Turns on by itself once a bot is connected (telegram.connect.ts); the card shows "Connect bot".',
}

/** Page-level safeguards with no single stored key (Rules & secrets). */
const PAGE_SAFEGUARDS = ['secretAccess', 'denyRules']

const offSettings = (Object.keys(DEFAULT_SETTINGS) as (keyof typeof DEFAULT_SETTINGS)[]).filter((k) => DEFAULT_SETTINGS[k] === false)
const offFlags = ENV_REGISTRY.filter((s) => s.kind === 'flag' && s.default !== 'on').map((s) => s.key)
const offSubs = CAPABILITY_IDS.flatMap((id) => (CAPABILITIES[id].subs ?? []).filter((s) => !s.defaultOn).map((s) => s.key))
const OFF_BY_DEFAULT: readonly string[] = [...offSettings, ...offFlags, ...offSubs]

describe('defaults are the most capable option', () => {
  it('finds the off-by-default switches (guards against a filter that passes vacuously)', () => {
    expect(OFF_BY_DEFAULT).toContain('WEBTERM_CENTRAL_AUTONOMY')
    expect(OFF_BY_DEFAULT).toContain('copyOnSelect')
  })

  it.each(OFF_BY_DEFAULT)('%s: off by default needs a safeguard, preference or automatic reason', (key) => {
    const why = SAFEGUARDS[key] ?? PREFERENCES[key] ?? AUTOMATIC[key]
    expect(why, `${key} defaults off with no reason: turn it on, or add it to SAFEGUARDS (shared/settings.safeguards.ts) with the reason the UI shows`).toBeTruthy()
  })

  it('the lists name only real keys, each in one list, and none that is on by default (stale)', () => {
    const listed = [...Object.keys(PREFERENCES), ...Object.keys(AUTOMATIC)]
    for (const key of listed) expect(OFF_BY_DEFAULT, `${key} is on by default now: drop it from the list`).toContain(key)
    const all = [...listed, ...Object.keys(SAFEGUARDS)]
    expect(all.filter((k, i) => all.indexOf(k) !== i)).toEqual([])
    for (const key of Object.keys(SAFEGUARDS)) {
      const real = key in DEFAULT_SETTINGS || specFor(key) !== undefined || PAGE_SAFEGUARDS.includes(key)
      expect(real, `SAFEGUARDS.${key} is not a Settings key, env key or page safeguard`).toBe(true)
    }
  })

  it('each safeguard reason is one short sentence', () => {
    for (const [key, reason] of Object.entries(SAFEGUARDS)) {
      expect(reason.length, key).toBeLessThanOrEqual(140)
      expect(reason.trim().endsWith('.'), key).toBe(true)
    }
  })
})
