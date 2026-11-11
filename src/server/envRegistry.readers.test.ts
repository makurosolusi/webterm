// Policy: every user-facing env key changes behaviour. A key counts as read when its literal appears in runtime
// code (not the registry, not the capability catalog/derived lists that only WRITE it, not UI location metadata),
// when it is a capability primary key (read through `isEnabled`), or when a named helper derives it
// (`derivedFlagKey('MEMORY')`, `filesFlagOn('WATCH')`). The old reader test was fooled by DERIVED_FLAGS itself.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CAPABILITIES, CAPABILITY_IDS } from '../shared/featureCapabilities'
import { ENV_REGISTRY } from './envRegistry'

const SERVER_DIR = new URL('.', import.meta.url).pathname
const SHARED_DIR = join(SERVER_DIR, '..', 'shared')
/** Files that mention keys without reading them: the catalog/derived writer, the legacy mapper, UI locations. */
const NOT_READERS = new Set(['featureCapabilities.ts', 'featureCapabilities.legacy.ts', 'effectiveConfig.ui.ts'])

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => { const f = join(dir, n); return statSync(f).isDirectory() ? walk(f) : [f] })
const strip = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(?<![:'"`])\/\/.*$/gm, '')
const corpus = [...walk(SERVER_DIR), ...walk(SHARED_DIR)]
  .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) && !/\.d\.ts$/.test(f) && !/^envRegistry/.test(basename(f)) && !NOT_READERS.has(basename(f)))
  .map((f) => strip(readFileSync(f, 'utf8')))
  .join('\n')
/**
 * Known dead keys still shown, each with the reason it is not retired yet. Shrinks to empty; a key that gains a
 * reader must leave this list (checked below).
 */
const DEAD_PENDING: Readonly<Record<string, string>> = {
  // TODO(settings-overhaul): retire WEBTERM_LEDGER; ledger is always on (ledgerRuntime.ts), but ~30 envSettings tests use it as their sample key.
  WEBTERM_LEDGER: 'Ignored since ledger is always on; retiring it means re-keying the envSettings test fixtures first.',
}
const PRIMARY = new Set(CAPABILITY_IDS.map((id) => CAPABILITIES[id].primaryKey))

function isRead(key: string): boolean {
  if (corpus.includes(`'${key}'`) || corpus.includes(`"${key}"`) || corpus.includes(`\`${key}\``) || PRIMARY.has(key)) return true
  const suffix = key.replace(/^WEBTERM_(CENTRAL_|FILES_)?/, '')
  return corpus.includes(`derivedFlagKey('${suffix}')`) || corpus.includes(`filesFlagOn('${suffix}')`)
}

describe('env registry: user-facing keys have a runtime reader', () => {
  it('every user-audience key is read directly, via isEnabled (primary key) or a named helper', () => {
    const user = ENV_REGISTRY.filter((s) => s.audience === 'user').map((s) => s.key)
    expect(user.length).toBeGreaterThan(10) // test-only: guards against an empty filter passing vacuously
    expect(user.filter((k) => !isRead(k) && !DEAD_PENDING[k])).toEqual([])
  })
  it('DEAD_PENDING holds only registered keys that really have no reader', () => {
    for (const k of Object.keys(DEAD_PENDING)) {
      expect(ENV_REGISTRY.some((s) => s.key === k), k).toBe(true)
      expect(isRead(k), `${k} has a reader now: drop it from DEAD_PENDING`).toBe(false)
    }
  })
  it('the corpus excludes the writers, so a key named only in DERIVED_FLAGS would fail', () => {
    // WEBTERM_CENTRAL_MEMORY is named in DERIVED_FLAGS (excluded) and read only through derivedFlagKey('MEMORY').
    expect(corpus.includes("'WEBTERM_CENTRAL_MEMORY'")).toBe(false)
    expect(isRead('WEBTERM_CENTRAL_MEMORY')).toBe(true)
    expect(isRead('WEBTERM_NO_SUCH_KEY')).toBe(false)
  })
})
