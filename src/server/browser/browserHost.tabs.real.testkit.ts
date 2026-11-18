// Harness of the real-Chromium tab tests (browserHost.tabs.real.bun.test.ts): a local page server, the production egress
// proxy + navigation guard (loopback allowed for this port only), and a BrowserHost over a headless Chrome pool.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ENV_BROWSER } from '../../shared/browser.contract'
import type { BrowserTabsState } from '../../shared/browser.tabs'
import { childEnv } from '../childEnv'
import { BrowserHost } from './browserHost.service'
import type { HostEvent } from './browserHost.targets'
import { toHostGuard } from './browser.guardAdapter'
import { CdpClient } from './cdp.client'
import { createChromiumPool } from './chromium.launch'
import { createNavigationGuard } from './navigation.guard'
import { allowKey } from './ssrf.allowlist'
import { startSsrfProxy } from './ssrf.proxy'

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
export const POLL_MS = 50
export const WAIT_MS = 10_000
const PROFILE = 'w1' // the workspace id openNode uses; the host's default profile is the workspace
const LAUNCH_ATTEMPTS = 3
export const TOKEN = 'token-123'
export const DIR_PREFIX = 'wt-tabsreal-'
const TICKER = '<div id=d></div><script>(function f(){d.textContent=performance.now();requestAnimationFrame(f)})()</script>'
const STAY = `<title>pending</title>${TICKER}<script>document.title='opener:'+(window.opener!==null)</script>`
/** Fixture pages: /main opens popups, /popup is the OAuth popup (postMessage then close), /stay stays, /blank-target has a target=_blank link. */
const PAGES: Record<string, string> = {
  '/main': `<title>main</title>${TICKER}<button id=o onclick="window.open('/popup')">o</button><button id=s onclick="window.open('/stay')">s</button><button id=w onclick="window.open('/popup-slow')">w</button>
<script>addEventListener('message',e=>{document.title='GOT:'+e.data})</script>`,
  '/popup': `<title>popup</title><script>window.opener.postMessage('${TOKEN}','*');window.close()</script>`,
  '/popup-slow': `<title>slow</title>${TICKER}<script>setTimeout(()=>{window.opener.postMessage('${TOKEN}','*');window.close()},1200)</script>`,
  '/stay': STAY,
  '/b': `<title>B</title>${TICKER}`,
  '/click': `<title>idle</title>${TICKER}<button id=k style="position:fixed;left:0;top:0;width:200px;height:100px" onclick="document.title='clicked'">k</button>`,
  // QC pages (sync + --all): same control by name on both, one only on the first, a heading each.
  '/qc-a': `<title>QA</title>${TICKER}<h1>Alpha</h1><button id=buy onclick="document.title='bought-a'">Buy</button><button id=only onclick="document.title='only-a'">OnlyA</button>`,
  '/qc-b': `<title>QB</title>${TICKER}<h1>Beta</h1><button id=buy onclick="document.title='bought-b'">Buy</button>`,
  '/blank-target': `<title>bt</title>${TICKER}<a id=l target=_blank href=/b>b</a>`,
}

export interface Rig {
  host: BrowserHost
  origin: string
  events: HostEvent[]
  /** Added to the host clock: moves the popup-burst window forward without waiting. */
  skew: { ms: number }
  dir: string
  stop(): Promise<void>
}

/** Boot server + proxy + pool + host; `discardMs` is the background-tab discard delay. */
export async function bootRig(bin: string, discardMs: number): Promise<Rig> {
  const server = createServer((req, res) => {
    const page = PAGES[(req.url ?? '').split('?')[0]]
    res.statusCode = page ? 200 : 404
    res.setHeader('content-type', 'text/html')
    res.end(page ?? '')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as AddressInfo).port
  const allow = new Set([allowKey('127.0.0.1', port)])
  const proxy = await startSsrfProxy({ allow, webtermPort: 1 })
  const dir = mkdtempSync(join(tmpdir(), DIR_PREFIX))
  // The temp HOME has no login keychain: without the mock one Chrome's cookie-key lookup stalls (same as chromium.real.bun.test.ts).
  const mock = (b: string, args: string[]) => spawn(b, [...args, '--use-mock-keychain'], { env: childEnv(), stdio: ['ignore', 'ignore', 'pipe'] })
  const pool = createChromiumPool({
    env: { [ENV_BROWSER.headless]: 'on', [ENV_BROWSER.bin]: bin }, dataRoot: dir, proxyServer: () => `http://127.0.0.1:${proxy.port}`, deps: { spawn: mock },
  })
  // On a loaded machine a fresh Chrome sometimes never answers its debugger socket; that is Chrome starting, not what is under
  // test. Prove the process answers (a few attempts, a new process each) before the host uses it.
  for (let attempt = 1; ; attempt++) {
    try { (await CdpClient.connect(await pool.acquire(PROFILE))).close(); break } catch (err) {
      pool.stop?.(PROFILE)
      if (attempt >= LAUNCH_ATTEMPTS) throw new Error(`Chromium did not answer its debugger socket in ${LAUNCH_ATTEMPTS} attempts`, { cause: err })
    }
  }
  const skew = { ms: 0 }
  const host = new BrowserHost({ launcher: pool, guard: toHostGuard(createNavigationGuard({ allow, webtermPort: 1 })), tabDiscardMs: discardMs, now: () => Date.now() + skew.ms })
  const events: HostEvent[] = []
  host.onEvent((e) => events.push(e))
  return {
    host, origin: `http://127.0.0.1:${port}`, events, skew, dir,
    async stop() {
      await host.dispose()
      pool.shutdown()
      await proxy.close()
      await new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()) })
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

export async function until<T>(what: string, probe: () => T | undefined | false | Promise<T | undefined | false>, ms = WAIT_MS): Promise<T> {
  for (let t = 0; t < ms; t += POLL_MS) {
    const v = await probe()
    if (v) return v
    await sleep(POLL_MS)
  }
  throw new Error(`timed out waiting for ${what}`)
}

export const tabsOf = (rig: Rig, node: string): BrowserTabsState => {
  const s = rig.host.tabsState(node)
  if (!s) throw new Error(`node ${node} has no tabs`)
  return s
}

/** Evaluate in one tab of a node; `gesture` = counts as a user click (popup blockers allow window.open). */
export async function evalIn<T>(rig: Rig, node: string, tabId: string, expression: string, gesture = false): Promise<T> {
  const r = (await rig.host.tabApi.cdpOnTab(node, tabId, 'Runtime.evaluate', { expression, returnByValue: true, userGesture: gesture })) as { result: { value: T }; exceptionDetails?: unknown }
  if (r.exceptionDetails) throw new Error(`evaluate failed in ${tabId}: ${expression}`)
  return r.result.value
}

/** Open a node at `path` and wait until its page rendered; returns the first tab id. */
export async function openNode(rig: Rig, node: string, path: string): Promise<string> {
  await rig.host.open(node, PROFILE, rig.origin + path)
  const id = await until('first tab', () => tabsOf(rig, node).activeTabId ?? undefined)
  await until(`${path} loaded`, async () => (await evalIn<boolean>(rig, node, id, '!!document.getElementById("d")')) || undefined)
  return id
}
