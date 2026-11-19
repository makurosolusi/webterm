import { describe, expect, it } from 'vitest'
import { CAPABILITIES, CAPABILITY_IDS, closure, dependents, deriveFlags, type CapabilityId } from './featureCapabilities'

/** Semua 2^7 = 128 subset katalog. */
const SUBSETS: Set<CapabilityId>[] = Array.from({ length: 1 << CAPABILITY_IDS.length }, (_, mask) =>
  new Set(CAPABILITY_IDS.filter((_id, i) => mask & (1 << i))))

const closeSet = (s: ReadonlySet<CapabilityId>): Set<CapabilityId> => new Set([...s].flatMap(closure))
// Tafsir env hasil deriveFlags tanpa runtime server: primer on DAN semua prasyarat on.
const read = (flags: Record<string, string>): Set<CapabilityId> => {
  const on = new Set<CapabilityId>()
  for (const id of CAPABILITY_IDS) {
    if (flags[CAPABILITIES[id].primaryKey] === 'on' && CAPABILITIES[id].implies.every((d) => on.has(d))) on.add(id)
  }
  return on
}

describe('katalog', () => {
  it('tujuh id, urutan topologis, prasyarat valid', () => {
    expect(CAPABILITY_IDS).toHaveLength(7)
    CAPABILITY_IDS.forEach((id, i) => {
      expect(CAPABILITIES[id].id).toBe(id)
      for (const dep of CAPABILITIES[id].implies) expect(CAPABILITY_IDS.indexOf(dep)).toBeLessThan(i)
    })
    expect(new Set(CAPABILITY_IDS.map((id) => CAPABILITIES[id].primaryKey)).size).toBe(7)
  })

  it('rantai implies sesuai kontrak', () => {
    expect(CAPABILITIES.workers.implies).toEqual(['central'])
    expect(CAPABILITIES.autonomy.implies).toEqual(['workers'])
    expect(CAPABILITIES.filesWrite.implies).toEqual(['files'])
    expect(CAPABILITIES.browser.needs).toBe('chromium')
    expect(CAPABILITIES.telegram.needs).toBe('telegramToken')
    expect(CAPABILITIES.workers.subs).toEqual([
      { key: 'WEBTERM_RUN_REQUIRE_APPROVAL', label: expect.any(String), defaultOn: false },
    ])
    // Kendali agent atas browser default ON (alat developer); tetap `dangerous` = mematikan/menyalakan lewat konfirmasi.
    expect(CAPABILITIES.browser.subs).toEqual([
      { key: 'WEBTERM_BROWSER_AGENT', label: expect.any(String), defaultOn: true, dangerous: true },
      // The other browser switches are plain ON-by-default toggles (no confirmation).
      { key: 'WEBTERM_BROWSER_CAPTURE_LINKS', label: expect.any(String), defaultOn: true },
      { key: 'WEBTERM_BROWSER_DOWNLOADS_AUTO', label: expect.any(String), defaultOn: true },
      { key: 'WEBTERM_BROWSER_ACCOUNTS', label: expect.any(String), defaultOn: true },
    ])
  })

  it('teks katalog Indonesia tanpa nama env var atau kata terlarang', () => {
    for (const id of CAPABILITY_IDS) {
      const d = CAPABILITIES[id]
      const text = [d.title, d.blurb, ...(d.subs ?? []).map((s) => s.label)].join(' ')
      expect(text).not.toMatch(/WEBTERM_|webhook|polling|secret|\bmode\b|restart|berbahaya|operator/i)
    }
  })
})

describe('closure/dependents', () => {
  it('closure: prasyarat dulu, id terakhir', () => {
    expect(closure('central')).toEqual(['central'])
    expect(closure('autonomy')).toEqual(['central', 'workers', 'autonomy'])
    expect(closure('filesWrite')).toEqual(['files', 'filesWrite'])
  })

  it('dependents: transitif, tanpa id sendiri', () => {
    expect(dependents('central')).toEqual(['workers', 'autonomy'])
    expect(dependents('workers')).toEqual(['autonomy'])
    expect(dependents('files')).toEqual(['filesWrite'])
    expect(dependents('browser')).toEqual([])
    expect(dependents('autonomy')).toEqual([])
  })
})

describe('properti eksaustif atas 128 subset', () => {
  it('ada 128 subset', () => expect(SUBSETS).toHaveLength(128))

  it('closure idempoten', () => {
    for (const s of SUBSETS) expect(closeSet(closeSet(s))).toEqual(closeSet(s))
  })

  it('deriveFlags(S) dibaca balik = closure(S), tak pernah inkoheren', () => {
    for (const s of SUBSETS) {
      const got = read(deriveFlags(s))
      expect(got).toEqual(closeSet(s))
      if (got.has('autonomy')) expect(got.has('workers')).toBe(true)
      if (got.has('workers')) expect(got.has('central')).toBe(true)
      if (got.has('filesWrite')) expect(got.has('files')).toBe(true)
    }
  })

  it('mematikan X mematikan semua dependents(X)', () => {
    for (const s of SUBSETS) {
      for (const x of CAPABILITY_IDS) {
        const off = new Set([...closeSet(s)].filter((id) => id !== x && !dependents(x).includes(id)))
        const got = read(deriveFlags(off))
        expect(got.has(x)).toBe(false)
        for (const dep of dependents(x)) expect(got.has(dep)).toBe(false)
      }
    }
  })

  it('deriveFlags menulis kunci primer (on/off) dan turunan konsisten dengan induknya', () => {
    const flags = deriveFlags(new Set(['autonomy', 'telegram']))
    expect(flags.WEBTERM_CENTRAL).toBe('on')
    expect(flags.WEBTERM_ORCHESTRATOR_RUN).toBe('on')
    expect(flags.WEBTERM_BROWSER).toBe('off')
    expect(flags.WEBTERM_CENTRAL_MEMORY).toBe('on')
    expect(flags.WEBTERM_CHANNELS).toBeUndefined()
    expect(flags.WEBTERM_CENTRAL_TELEGRAM).toBeUndefined()
    expect(flags.WEBTERM_FILES_UPLOAD).toBe('off')
    expect(deriveFlags(new Set(['telegram'])).WEBTERM_TELEGRAM).toBe('on')
    expect(Object.values(deriveFlags(new Set())).every((v) => v === 'off')).toBe(true)
  })
})
