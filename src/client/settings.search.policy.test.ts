// Policy lock for the Settings search index (./settings.search): every `data-field` that Settings renders
// has an index entry and every indexed field is rendered, so search can neither miss a setting nor offer
// one that "Go to" cannot reveal. Labels written next to a literal id must equal the indexed label.
// "Rendered" = literal ids in files reachable from SettingsPanel.tsx, plus the registry-driven ids
// (Central rows, capability cards).
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { expect, it } from 'vitest'
import { CAPABILITY_IDS } from '../shared/featureCapabilities'
import { CENTRAL_FIELDS } from './centralSettings.registry'
import { toSettingsFieldId } from './settings.link'
import { SETTINGS_SEARCH_INDEX, searchSettings } from './settings.search'
import { SETTINGS_SECTIONS } from './settingsSections.registry'

const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

function resolve(from: string, spec: string): string | undefined {
  const base = join(dirname(from), spec)
  return [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')].find((p) => existsSync(p) && statSync(p).isFile())
}

/** file (relative) → its comment-free source, for every module SettingsPanel.tsx imports transitively. */
function reachable(): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (file: string): void => {
    const rel = relative(__dirname, file)
    if (out.has(rel) || !/\.tsx?$/.test(file)) return
    const text = code(readFileSync(file, 'utf8'))
    out.set(rel, text)
    for (const m of text.matchAll(/from '(\.{1,2}\/[^']+)'/g)) { const r = resolve(file, m[1]); if (r) walk(r) }
  }
  walk(join(__dirname, 'SettingsPanel.tsx'))
  return out
}

const ID = /(?<![\w-])(?:data-field|field|setting)="([^"$]+)"/g
/** Capability cards Settings › Features renders (Central, Workers and Autonomy are switched in Central Agent). */
const CARD_IDS = CAPABILITY_IDS.filter((id) => id !== 'central' && id !== 'workers' && id !== 'autonomy')

const files = reachable()
const literal = [...files].flatMap(([file, text]) => [...text.matchAll(ID)].map((m) => ({ file, id: m[1], at: m.index })))
const rendered = new Set([
  ...literal.map((x) => x.id),
  ...CENTRAL_FIELDS.map((f) => `central.${f.id}`),
  ...CARD_IDS.map((id) => `capability.${id}`),
])
const indexed = SETTINGS_SEARCH_INDEX.flatMap((x) => (x.field ? [x.field as string] : []))

it('the scan really walked the Settings tree', () => {
  expect(files.size).toBeGreaterThan(50)
  // Floor, not a count: the General/Claude/Central rework cut the literal ids to under 40.
  expect(literal.length).toBeGreaterThan(30)
})

it('every rendered data-field has an index entry, and every indexed field is rendered', () => {
  expect([...rendered].filter((id) => !indexed.includes(id)).sort()).toEqual([])
  expect(indexed.filter((id) => !rendered.has(id))).toEqual([])
  expect(indexed.filter((id, i) => indexed.indexOf(id) !== i)).toEqual([]) // one entry per field
  expect(indexed.filter((id) => toSettingsFieldId(id) === null)).toEqual([])
})

it('a literal label next to a literal id equals the indexed label', () => {
  const byField = new Map(SETTINGS_SEARCH_INDEX.map((x) => [x.field as string, x.label]))
  const stale = literal.flatMap(({ file, id, at }) => {
    const text = files.get(file)!
    const start = text.lastIndexOf('<', at)
    const rest = text.slice(start)
    const element = rest.slice(0, rest.search(/\/>|[^=]>\s*\n/) + 1)
    const label = /\blabel="([^"]+)"/.exec(element)?.[1]
    return label && label !== byField.get(id) ? [`${file} ${id}: "${label}" vs "${byField.get(id)}"`] : []
  })
  expect(stale).toEqual([])
})

it('every page is searchable by its own title', () => {
  for (const s of SETTINGS_SECTIONS) expect(searchSettings(s.label.toLowerCase()).map((g) => g.page), s.id).toContain(s.id)
})
