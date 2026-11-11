// Policy: every Settings key changes behaviour somewhere. A key counts as read when runtime code outside the
// settings schema and Settings UI accesses it (`.key`, `'key'`, `{ key`, `, key`). Purely internal state
// (wizard progress, combobox history) must be named in INTERNAL with a reason instead of passing silently.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, mergeSettings } from './settings'

const SRC = join(new URL('.', import.meta.url).pathname, '..')
/** Keys that are app-internal state, not a preference with an effect elsewhere. Empty while every key has a reader. */
const INTERNAL: Readonly<Record<string, string>> = {}

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => { const f = join(dir, n); return statSync(f).isDirectory() ? walk(f) : [f] })
/** Settings plumbing: the schema (shared/settings*) and the Settings UI (client Settings*, settings*, centralSettings*, useSettings*). */
const plumbing = (f: string): boolean =>
  /\/(client|shared)\//.test(f) && /^(settings|Settings|centralSettings|useSettings)/.test(basename(f))
const strip = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(?<![:'"`])\/\/.*$/gm, '')
const corpus = walk(SRC)
  .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) && !/\.d\.ts$/.test(f) && !plumbing(f))
  .map((f) => strip(readFileSync(f, 'utf8')))
  .join('\n')
const isRead = (key: string): boolean => new RegExp(`[.'"]${key}\\b|[{,]\\s*${key}\\b`).test(corpus)

describe('settings: every key has a runtime reader', () => {
  it('each DEFAULT_SETTINGS key is read outside settings plumbing, or listed as INTERNAL', () => {
    expect(Object.keys(DEFAULT_SETTINGS).filter((k) => !isRead(k) && !INTERNAL[k])).toEqual([])
  })
  it('INTERNAL names only real keys, with a reason', () => {
    for (const [k, why] of Object.entries(INTERNAL)) {
      expect(k in DEFAULT_SETTINGS, k).toBe(true)
      expect(why.length, k).toBeGreaterThan(10)
    }
  })
  it('the matcher is not vacuous: an unknown key is not "read"', () => {
    expect(isRead('noSuchSettingKeyAnywhere')).toBe(false)
  })
  it('removed dead keys (defaultAgent, accent) are dropped from stored settings without error', () => {
    const merged = mergeSettings({ defaultAgent: 'custom:x', accent: '#ff0000', fontSize: 15 }) as unknown as Record<string, unknown>
    expect(merged.defaultAgent).toBeUndefined()
    expect(merged.accent).toBeUndefined()
    expect(merged.fontSize).toBe(15)
  })
})
