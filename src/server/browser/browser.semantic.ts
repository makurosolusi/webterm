// Semantic element matching: the same element found again in ANOTHER page by what it is (role + accessible name + n-th
// among equals in the accessibility tree), never by a snapshot ref. Used by sync mode (a human click mirrored into the
// other panes) and by `click|type --all --text` (one action on every tab). Pure matching on top, a small CDP layer below.
import type { BrowserInputEvent, KeyInput } from '../../shared/browser.contract'
import { AGENT_CDP } from './browserAgent.cdpAllowlist'
import { cleanName, INTERACTIVE, SKIP_ROLES } from './browserAgent.snapshot'
import type { AxNode } from './browserAgent.snapshot'
import { mouse } from './browserAgent.verbs.act'
import { CdpCommandError } from './cdp.client'

/** `nth` is 1-based among the elements with the same role and name, in tree order. */
export interface SemanticTarget { role?: string; name: string; nth: number }

const roleOf = (n: AxNode): string => (typeof n.role?.value === 'string' ? n.role.value : '')
const nameOf = (n: AxNode): string => cleanName(n.name?.value).toLowerCase()
const norm = (s: string): string => cleanName(s).toLowerCase()

/** Elements a person could point at: not ignored, in the DOM, named, and with a real role. */
const candidates = (nodes: readonly AxNode[]): AxNode[] =>
  nodes.filter((n) => !n.ignored && Number.isInteger(n.backendDOMNodeId) && !SKIP_ROLES.has(roleOf(n)) && roleOf(n) !== '' && nameOf(n) !== '')

/**
 * The element a target names in this page, or undefined. `exact` = the whole accessible name (sync); otherwise an exact name
 * wins and a name that merely contains the text is the fallback (an agent's `--text`). Without a role, controls (buttons,
 * links, fields) are preferred over the static text inside them.
 */
export function findTarget(nodes: readonly AxNode[], t: SemanticTarget, exact = true): AxNode | undefined {
  const want = norm(t.name)
  if (want === '') return undefined
  const role = t.role?.toLowerCase()
  const pool = candidates(nodes).filter((n) => !role || roleOf(n).toLowerCase() === role)
  const pick = (m: AxNode[]): AxNode[] => (role ? m : m.some((n) => INTERACTIVE.has(roleOf(n))) ? m.filter((n) => INTERACTIVE.has(roleOf(n))) : m)
  const same = pick(pool.filter((n) => nameOf(n) === want))
  const list = same.length || exact ? same : pick(pool.filter((n) => nameOf(n).includes(want)))
  return list[Math.max(1, t.nth) - 1]
}

/** What a human pointed at (`backendId`) as a target: its nearest named control, with its place among elements of the same role+name. */
export function describeAt(nodes: readonly AxNode[], backendId: number): SemanticTarget | null {
  const parent = new Map<string, AxNode>()
  for (const n of nodes) for (const c of n.childIds ?? []) if (typeof n.nodeId === 'string') parent.set(c, n)
  let cur = nodes.find((n) => n.backendDOMNodeId === backendId)
  let fallback: AxNode | undefined
  for (let hops = 0; cur && hops < 40; hops++) {
    const role = roleOf(cur)
    if (!cur.ignored && !SKIP_ROLES.has(role) && nameOf(cur) !== '') {
      if (INTERACTIVE.has(role)) { fallback = cur; break }
      fallback ??= role === 'StaticText' ? undefined : cur
    }
    cur = typeof cur.nodeId === 'string' ? parent.get(cur.nodeId) : undefined
  }
  if (!fallback) return null
  const role = roleOf(fallback)
  const same = candidates(nodes).filter((n) => roleOf(n) === role && nameOf(n) === nameOf(fallback as AxNode))
  const at = same.indexOf(fallback)
  return at < 0 ? null : { role, name: nameOf(fallback), nth: at + 1 }
}

/** The page the semantic actions act in: CDP and input of ONE tab. */
export interface TabIo {
  cdp(method: string, params?: object): Promise<unknown>
  input(ev: BrowserInputEvent): Promise<void>
}
export type SemanticOutcome = 'ok' | 'no_match' | 'cross_origin'

const gone = (e: unknown): boolean => e instanceof CdpCommandError // the element vanished between the tree and the action: same as no match

async function resolve(io: TabIo, t: SemanticTarget, exact: boolean): Promise<number | undefined> {
  const tree = (await io.cdp(AGENT_CDP.axTree)) as { nodes?: AxNode[] }
  const found = findTarget(Array.isArray(tree.nodes) ? tree.nodes : [], t, exact)
  return found?.backendDOMNodeId
}

/** A button that submits to another origin (`formaction`) is the one thing a mirrored click must not do silently (P-10). */
async function crossOriginSubmit(io: TabIo, backendNodeId: number, pageUrl: string): Promise<boolean> {
  const { node } = (await io.cdp(AGENT_CDP.describe, { backendNodeId })) as { node?: { attributes?: string[] } }
  const attrs = node?.attributes ?? []
  const at = attrs.findIndex((a, i) => i % 2 === 0 && a.toLowerCase() === 'formaction')
  if (at < 0) return false
  try {
    return new URL(attrs[at + 1], pageUrl).origin !== new URL(pageUrl).origin
  } catch {
    return true // an unparseable target cannot be shown to be same-origin
  }
}

/** Click the element `t` names in this page. */
export async function clickTarget(io: TabIo, t: SemanticTarget, pageUrl: string, exact = true): Promise<SemanticOutcome> {
  try {
    const id = await resolve(io, t, exact)
    if (id === undefined) return 'no_match'
    if (await crossOriginSubmit(io, id, pageUrl)) return 'cross_origin'
    await io.cdp(AGENT_CDP.scrollIntoView, { backendNodeId: id })
    const { quads } = (await io.cdp(AGENT_CDP.quads, { backendNodeId: id })) as { quads?: number[][] }
    const q = quads?.[0]
    if (!q || q.length < 8 || !q.slice(0, 8).every(Number.isFinite)) return 'no_match'
    const x = (q[0] + q[2] + q[4] + q[6]) / 4, y = (q[1] + q[3] + q[5] + q[7]) / 4
    await io.input(mouse('move', x, y, 0))
    await io.input(mouse('down', x, y, 1))
    await io.input(mouse('up', x, y, 0))
    return 'ok'
  } catch (err) {
    if (gone(err)) return 'no_match'
    throw err
  }
}

const ENTER: KeyInput = { t: 'key', type: 'down', key: 'Enter', code: 'Enter', text: '\r', vk: 13, mods: 0 }

/** Focus the field `t` names and type `text` at its caret (Enter after it when `submit`). */
export async function typeTarget(io: TabIo, t: SemanticTarget, text: string, submit: boolean, exact = true): Promise<SemanticOutcome> {
  try {
    const id = await resolve(io, t, exact)
    if (id === undefined) return 'no_match'
    await io.cdp(AGENT_CDP.scrollIntoView, { backendNodeId: id })
    await io.cdp(AGENT_CDP.focus, { backendNodeId: id })
    await io.input({ t: 'text', text })
    if (submit) { await io.input(ENTER); await io.input({ ...ENTER, type: 'up' }) }
    return 'ok'
  } catch (err) {
    if (gone(err)) return 'no_match'
    throw err
  }
}
