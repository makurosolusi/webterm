// Smoke cases for browser TABS (docs/smoke-capabilities.md): a tiny local site, the prompts and the pure grading.
// The site is served by the smoke process itself on a random loopback port (stopped in `finally` by the caller):
// page A links to B with target=_blank, so a click must open a NEW TAB in the same node, not a new node.
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Evidence, ToolEvidence, Verdict } from './smoke.capabilities.judge'

export const HEADING_B = 'Page B Heading'
const PAGES: Record<string, { title: string; body: string }> = {
  '/': { title: 'Page A', body: '<h1>Page A Heading</h1><a href="/b" target="_blank">Open B</a>' },
  '/b': { title: 'Page B', body: `<h1>${HEADING_B}</h1><p>You reached the second page.</p>` },
  '/c': { title: 'Page C', body: '<h1>Page C Heading</h1>' },
}

export interface TabsSite { port: number; stop: () => void }

/** Serves pages A (`/`), B (`/b`) and C (`/c`) on a random loopback port (node:http: the smoke scripts have no Bun types). */
export function startTabsSite(): Promise<TabsSite> {
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
export const tabsSite = { port: 0 }

export const tabOpenPrompt = (p: number): string => `Open http://127.0.0.1:${p}/ in a browser node, click the link Open B (it opens in a new tab), and tell me the heading of the new tab`
export const tabMultiPrompt = (p: number): string =>
  `Use ONE browser node (open one if none exists): load http://127.0.0.1:${p}/ in it, then open http://127.0.0.1:${p}/c in a second tab of that same node. Tell me the page title of both pages.`
export const tabDeniedPrompt = (p: number): string =>
  `Open http://127.0.0.1:${p}/ in the browser, then open http://127.0.0.1:${p}/c in a second tab with \`webterm browser tab new\` and list the tabs with \`webterm browser tabs\``

const label = (t: ToolEvidence): string => `${t.name}:${t.id.slice(-6)}=${t.state}${t.code && t.state !== 'ok' ? `(${t.code})` : ''}`
const ids = (ev: Evidence): string => ev.tools.map(label).join(' ') || 'no tool call'
const nodes = (ev: Evidence): string => `new browser nodes=${ev.newBrowserNodes ?? '?'}`

/** (a) chat.default: a click on a target=_blank link answered `newTab`, the answer has B's heading, and the board gained exactly ONE browser node. */
export function gradeTabOpen(ev: Evidence): Verdict {
  const click = ev.tools.find((t) => t.name === 'Bash' && t.state === 'ok' && /webterm browser click\b/.test(t.command) && /"newTab"/.test(t.output ?? ''))
  if (!click) return { pass: false, evidence: `FAIL no successful click whose answer carried newTab; ${ids(ev)}; ${nodes(ev)}` }
  if (!ev.text.includes(HEADING_B)) return { pass: false, evidence: `FAIL "${HEADING_B}" missing from the answer; ${ids(ev)}; ${nodes(ev)}` }
  if (ev.newBrowserNodes !== 1) return { pass: false, evidence: `FAIL expected exactly one browser node, ${nodes(ev)}; ${ids(ev)}` }
  return { pass: true, evidence: `${label(click)} answered newTab; "${HEADING_B}" in answer; ${nodes(ev)}` }
}

/** (b) central.steward: `browser_tab new` ran OK, both titles are reported, and at most ONE browser node was added (an idle one may be reused). */
export function gradeTabMulti(ev: Evidence): Verdict {
  const made = ev.tools.find((t) => /browser_tab$/.test(t.name) && t.state === 'ok' && /127\.0\.0\.1/.test(t.command))
  if (!made) return { pass: false, evidence: `FAIL no successful browser_tab new with a url; ${ids(ev)}; ${nodes(ev)}` }
  for (const title of ['Page A', 'Page C']) if (!ev.text.includes(title)) return { pass: false, evidence: `FAIL title "${title}" missing from the answer; ${ids(ev)}; ${nodes(ev)}` }
  if ((ev.newBrowserNodes ?? 99) > 1) return { pass: false, evidence: `FAIL more than one browser node added, ${nodes(ev)}; ${ids(ev)}` }
  return { pass: true, evidence: `${label(made)}; both titles reported; ${nodes(ev)}` }
}

/** (c) control, chat.skill-author: no tab verb may succeed. A refusal proves enforcement; no attempt is labelled as such. */
export function gradeTabDenied(ev: Evidence): Verdict {
  const tries = ev.tools.filter((t) => t.name === 'Bash' && /webterm browser (tabs\b|tab\b|\S+.*--tab\b)/.test(t.command))
  const leaked = tries.filter((t) => t.state === 'ok')
  if (leaked.length > 0) return { pass: false, evidence: `FAIL a tab verb succeeded for the author; ${leaked.map(label).join(' ')}` }
  if (tries.length === 0) return { pass: true, evidence: `no attempt: model declined itself, enforcement not exercised; ${ids(ev)}` }
  return { pass: true, evidence: `refused: ${tries.map(label).join(' ')}` }
}
