// The simple layout spec an agent writes (`layout set h t1 new:https://b.test`): one word for the shape, then the tabs.
// Pure: parsing and tree building only; resolving `new:<url>` into real tabs is the server's job.
//   single <tab>            one pane (no split)       h <tab> <tab> [...]    columns, left to right (2-4)
//   v <tab> <tab> [...]     rows, top to bottom (2-4)  grid <t1> <t2> <t3> <t4>   2x2: t1 t2 over t3 t4
import { MAX_PANES } from './browser.layout'
import { MAX_TAB_URL_LENGTH, validateTabUrl } from './browser.tabs'
import type { Pane } from './workspace.shape'

export type SpecMode = 'single' | 'h' | 'v' | 'grid'
/** One pane of the spec: an existing tab, or a tab to open at `url` first. */
export type SpecLeaf = { tab: string } | { url: string }
export type ParsedSpec = { ok: true; mode: SpecMode; leaves: SpecLeaf[] } | { ok: false; error: string }

const TAB_ID = /^[A-Za-z0-9_-]{1,64}$/
export const LAYOUT_SPEC_USAGE = 'single <tab> | h <tab> <tab> [<tab> <tab>] | v <tab> <tab> [<tab> <tab>] | grid <t1> <t2> <t3> <t4>; a tab is an id from `tabs` or new:<url>'
const MODES: readonly SpecMode[] = ['single', 'h', 'v', 'grid']

/** Spec text -> mode + leaves. Every refusal names the fix, so the caller can pass it on as is. */
export function parseLayoutSpec(spec: unknown): ParsedSpec {
  if (typeof spec !== 'string' || spec.length > MAX_PANES * (MAX_TAB_URL_LENGTH + 8)) return { ok: false, error: `spec must be text like: ${LAYOUT_SPEC_USAGE}` }
  const [mode, ...rest] = spec.trim().split(/\s+/)
  if (!(MODES as readonly string[]).includes(mode)) return { ok: false, error: `unknown shape "${mode.slice(0, 20)}"; use ${LAYOUT_SPEC_USAGE}` }
  const want = mode === 'single' ? [1, 1] : mode === 'grid' ? [MAX_PANES, MAX_PANES] : [2, MAX_PANES]
  if (rest.length < want[0] || rest.length > want[1]) {
    return { ok: false, error: mode === 'grid' ? 'grid needs exactly 4 tabs' : mode === 'single' ? 'single needs exactly 1 tab' : `${mode} needs 2 to ${MAX_PANES} tabs (at most ${MAX_PANES} panes)` }
  }
  const leaves: SpecLeaf[] = []
  const seen = new Set<string>()
  for (const tok of rest) {
    if (tok.startsWith('new:')) {
      const url = validateTabUrl(tok.slice(4))
      if (!url.ok || url.url === '' || url.url === 'about:blank') return { ok: false, error: 'new:<url> needs an http(s) URL, for example new:https://example.com' }
      leaves.push({ url: url.url })
    } else {
      if (!TAB_ID.test(tok)) return { ok: false, error: `"${tok.slice(0, 40)}" is not a tab id (use an id from tabs, or new:<url>)` }
      if (seen.has(tok)) return { ok: false, error: `tab ${tok} appears twice; a tab shows in one pane only` }
      seen.add(tok)
      leaves.push({ tab: tok })
    }
  }
  return { ok: true, mode: mode as SpecMode, leaves }
}

const leaf = (id: string): Pane => ({ id })
/** n equal panes in one direction, as a right-leaning chain (each ratio gives every pane the same share). */
function chain(dir: 'h' | 'v', ids: string[]): Pane {
  if (ids.length === 1) return leaf(ids[0])
  return { dir, ratio: 1 / ids.length, a: leaf(ids[0]), b: chain(dir, ids.slice(1)) }
}

/** Tab ids (one per leaf, in spec order) -> the layout to store; null = one pane (`single`). */
export function layoutFromSpec(mode: SpecMode, ids: readonly string[]): Pane | null {
  if (mode === 'single') return null
  if (mode === 'grid') return { dir: 'v', ratio: 0.5, a: { dir: 'h', ratio: 0.5, a: leaf(ids[0]), b: leaf(ids[1]) }, b: { dir: 'h', ratio: 0.5, a: leaf(ids[2]), b: leaf(ids[3]) } }
  return chain(mode, [...ids])
}

/** Compact text of a layout for an agent: `h(t1, v(t2, t3))`. */
export function describeLayout(p: Pane): string {
  return 'id' in p ? p.id : `${p.dir}(${describeLayout(p.a)}, ${describeLayout(p.b)})`
}
