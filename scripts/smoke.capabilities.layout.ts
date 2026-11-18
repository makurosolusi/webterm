// Smoke cases for the browser SPLIT layout (docs/smoke-capabilities.md): a tiny local site with two different pages, the prompts
// and the pure grading. Served by the smoke process on a random loopback port (stopped in `finally` by the caller). The model must
// put the two pages side by side in ONE browser node (`layout set` / `browser_layout`) instead of opening two nodes.
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Evidence, ToolEvidence, Verdict } from './smoke.capabilities.judge'

export const HEADING_ALPHA = 'Alpha Heading'
export const HEADING_BETA = 'Beta Heading'
const PAGES: Record<string, { title: string; body: string }> = {
  '/a': { title: 'Alpha', body: `<h1>${HEADING_ALPHA}</h1><p>First page.</p>` },
  '/b': { title: 'Beta', body: `<h1>${HEADING_BETA}</h1><p>Second page.</p>` },
}

export interface LayoutSite { port: number; stop: () => void }

/** Serves `/a` and `/b` on a random loopback port (node:http: the smoke scripts have no Bun types). */
export function startLayoutSite(): Promise<LayoutSite> {
  const server = createServer((req, res) => {
    const page = PAGES[new URL(req.url ?? '/', 'http://x').pathname]
    if (!page) { res.writeHead(404).end('not found'); return }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html><html><head><meta charset="utf-8"><title>${page.title}</title></head><body>${page.body}</body></html>`)
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve({ port: (server.address() as AddressInfo).port, stop: () => { server.closeAllConnections(); server.close() } }))
  })
}

/** Port of the site of the current run; set by the runner before the cases start. */
export const layoutSite = { port: 0 }

export const layoutPrompt = (p: number): string => `Open http://127.0.0.1:${p}/a and http://127.0.0.1:${p}/b side by side in one browser node and tell me both headings`

const label = (t: ToolEvidence): string => `${t.name}:${t.id.slice(-6)}=${t.state}${t.code && t.state !== 'ok' ? `(${t.code})` : ''}`
const ids = (ev: Evidence): string => ev.tools.map(label).join(' ') || 'no tool call'
const nodes = (ev: Evidence): string => `new browser nodes=${ev.newBrowserNodes ?? '?'}`

/** The model split the node itself: a successful layout call that set a shape (not merely a read of the layout). */
const settingChat = (t: ToolEvidence): boolean => t.name === 'Bash' && t.state === 'ok' && /webterm browser layout set\b/.test(t.command)
const settingCentral = (t: ToolEvidence): boolean => /browser_layout$/.test(t.name) && t.state === 'ok' && t.action === 'set'

function gradeSplit(ev: Evidence, made: ToolEvidence | undefined, what: string, maxNodes: number): Verdict {
  if (!made) return { pass: false, evidence: `FAIL no successful ${what}; ${ids(ev)}; ${nodes(ev)}` }
  for (const h of [HEADING_ALPHA, HEADING_BETA]) if (!ev.text.includes(h)) return { pass: false, evidence: `FAIL "${h}" missing from the answer; ${ids(ev)}; ${nodes(ev)}` }
  if ((ev.newBrowserNodes ?? 99) > maxNodes) return { pass: false, evidence: `FAIL more than ${maxNodes} browser node(s) added, ${nodes(ev)}; ${ids(ev)}` }
  return { pass: true, evidence: `${label(made)}; both headings reported; ${nodes(ev)}` }
}

/** chat.default: `webterm browser layout set` ran, both headings are in the answer, and the board gained exactly ONE browser node. */
export const gradeLayoutChat = (ev: Evidence): Verdict => {
  const v = gradeSplit(ev, ev.tools.find(settingChat), '`webterm browser layout set`', 1)
  return v.pass && ev.newBrowserNodes !== 1 ? { pass: false, evidence: `FAIL expected exactly one browser node, ${nodes(ev)}; ${ids(ev)}` } : v
}

/** central.steward: `browser_layout set` ran OK, both headings reported, at most one node added (an idle one may be reused). */
export const gradeLayoutCentral = (ev: Evidence): Verdict => gradeSplit(ev, ev.tools.find(settingCentral), '`browser_layout` set', 1)

/** Control, chat.skill-author: no layout/sync/--all verb may succeed. A refusal proves enforcement; no attempt is labelled as such. */
export function gradeLayoutDenied(ev: Evidence): Verdict {
  const tries = ev.tools.filter((t) => t.name === 'Bash' && /webterm browser (layout|arrange|sync|reload|back|forward)\b|webterm browser .*--(all|layout)\b/.test(t.command))
  const leaked = tries.filter((t) => t.state === 'ok')
  if (leaked.length > 0) return { pass: false, evidence: `FAIL a layout verb succeeded for the author; ${leaked.map(label).join(' ')}` }
  if (tries.length === 0) return { pass: true, evidence: `no attempt: model declined itself, enforcement not exercised; ${ids(ev)}` }
  return { pass: true, evidence: `refused: ${tries.map(label).join(' ')}` }
}
