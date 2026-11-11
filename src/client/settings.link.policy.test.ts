// Policy lock: a link that opens Settings toward a specific setting names it (`openSettingsAt(section,
// field)`, a `{ section, field }` link target), so Settings can reveal it (VS Code "reveal setting").
// Only "open the whole section" entry points may go without a field, and each is listed in EXEMPT with
// its reason. Every literal `data-field` must be an id a link may target (`toSettingsFieldId`).
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { expect, it } from 'vitest'
import { toSettingsFieldId } from './settings.link'

const CLIENT = __dirname

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sources(path)
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : []
  })
}
const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

/** file → why it opens a whole section without a field. */
const EXEMPT: Record<string, string> = {
  'App.tsx': 'Account menu item: the Account page as a whole',
  'App.route.ts': 'gear / Mod+, (Preferences: Open Settings): reopens the last section',
  'canvasBackground.open.ts': 'Canvas background section scoped to the workspace: the scope is the target',
  'central/AbilitiesView.tsx': 'Rules & secrets section: the whole allow/ask/deny list',
}

/** Calls that open Settings without naming a field. */
function unnamed(text: string): string[] {
  const body = code(text)
  const hits: string[] = []
  for (const m of body.matchAll(/\bnew CustomEvent\(\s*OPEN_SETTINGS_EVENT/g)) hits.push(m[0])
  for (const m of body.matchAll(/\bopenSettingsSection\(([^)]*)\)/g)) if (m[1].trim()) hits.push(m[0])
  for (const m of body.matchAll(/\.openSettings\(([^)]*)\)/g)) if (!m[1].includes(',')) hits.push(m[0])
  for (const m of body.matchAll(/\bopenSettingsAt\(([^)]*)\)/g)) if (!m[1].includes(',')) hits.push(m[0])
  for (const m of body.matchAll(/\b(?:onNavigate|c\.navigate)\(\s*\{([^}]*)\}/g)) if (!/\bfield:/.test(m[1])) hits.push(m[0])
  return hits
}

it('the scanner flags field-less opens and passes named ones', () => {
  expect(unnamed("openSettingsAt('central')")).toHaveLength(1)
  expect(unnamed("openSettingsAt('central', 'central.level')")).toEqual([])
  expect(unnamed("onNavigate({ section: 'central' })")).toHaveLength(1)
  expect(unnamed("onNavigate({ section: 'central', field: 'central.costLimit' })")).toEqual([])
  expect(unnamed("window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { detail: { section: 'x' } }))")).toHaveLength(1)
  expect(unnamed("actions.openSettings('account')")).toHaveLength(1)
  expect(unnamed('// openSettingsAt(\'central\') in a comment')).toEqual([])
})

it('every link into Settings names its field, except the listed whole-section openers', () => {
  const files = sources(CLIENT)
  expect(files.length).toBeGreaterThan(100) // the walk really saw the client tree
  const found = files
    .map((path) => ({ file: relative(CLIENT, path), hits: unnamed(readFileSync(path, 'utf8')) }))
    .filter((f) => f.hits.length && f.file !== 'settings.link.ts' && !(f.file in EXEMPT))
  expect(found).toEqual([])
  for (const file of Object.keys(EXEMPT)) expect(unnamed(readFileSync(join(CLIENT, file), 'utf8')).length, file).toBeGreaterThan(0) // no stale entry
})

it('every literal data-field is a linkable setting id', () => {
  const ids = sources(CLIENT).flatMap((path) => [...code(readFileSync(path, 'utf8')).matchAll(/\s(?:data-)?field="([^"]+)"/g)].map((m) => m[1]))
  expect(ids.length).toBeGreaterThan(5)
  expect(ids.filter((id) => toSettingsFieldId(id) === null)).toEqual([])
})

it('the reveal flash has a reduced-motion variant (a still outline)', () => {
  const css = readFileSync(join(CLIENT, 'settings-sections.css'), 'utf8')
  expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.st-reveal\s*\{\s*animation: none;\s*outline:/)
})
