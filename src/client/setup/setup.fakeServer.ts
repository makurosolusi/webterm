// test-only: a fake webterm server for the wizard tests. Routes by URL + method, keeps the
// capability set (closing prerequisites/dependents like the real service) and records every call.
import { vi } from 'vitest'
import { CAPABILITIES, CAPABILITY_IDS, closure, dependents, type CapabilitiesResponse, type CapabilityId, type ChromiumDownloadStatus } from '../../shared/featureCapabilities'
import type { LaunchTest } from '../claudeLauncher/claudeLaunch.client'
import type { FinalEvent, StageEvent } from '../claudeLauncher/connectionTest.client'

export interface FakeServer {
  calls: { url: string; method: string; body?: unknown }[]
  on: Set<CapabilityId>
  candidates: string[]
  chromiumValue: string
  /** POST /api/claude-launch/test answer (Central step's launch status). */
  launch: LaunchTest | 'error'
  /** POST /api/claude-provider/test NDJSON lines (the wizard's and the card's Test connection); 'error' = 500. */
  connection: (StageEvent | FinalEvent)[] | 'error'
  /** Capability GET answers 500 this many times. */
  capsFail: number
  /** Next capability POST answers 500. */
  postFail: boolean
  extras: Record<string, unknown>
  /** "Download Chromium" status the server reports; POST start/cancel move it, tests move it on. */
  download: ChromiumDownloadStatus
  /** Next download request answers 500. */
  downloadFail: boolean
  /** GET /api/claude-provider answer. */
  provider: Record<string, unknown>
  /** Next provider PUT answers 500. */
  providerSaveFail: boolean
}

export const DL_IDLE: ChromiumDownloadStatus = { state: 'idle', percent: 0, bytes: 0, total: 0, error: null, executablePath: null }

export const READY: LaunchTest = {
  ok: true, profile: { id: 'default', name: 'Default' }, warnings: [],
  steps: [{ stage: 'claude', ok: true, message: 'claude found' }, { stage: 'auth', ok: true, message: 'Signed in' }],
}

const via = 'Claude Code login'
/** A passing Test connection (test-only). */
export const CONN_OK: (StageEvent | FinalEvent)[] = [
  { stage: 'wrapper', state: 'skipped', detail: 'No wrapper in the launch command' },
  { stage: 'cli', state: 'ok', detail: 'claude 2.1.318 (Claude Code)', ms: 120 },
  { stage: 'auth', state: 'ok', detail: 'Signed in (claude.ai)', ms: 80 },
  { stage: 'request', state: 'ok', detail: 'claude-haiku-4-5 answered in 1.2 s', ms: 1200 },
  { result: 'ok', summary: `Connection works — Claude answered in 1.4 s via ${via}`, ms: 1400, via, model: 'claude-haiku-4-5' },
]

export const CONN_NOT_FOUND: (StageEvent | FinalEvent)[] = [
  { stage: 'wrapper', state: 'skipped', detail: 'No wrapper in the launch command' },
  {
    stage: 'cli', state: 'failed', detail: 'The claude CLI was not found on PATH.', ms: 1,
    install: { installCommand: 'curl -fsSL https://claude.ai/install.sh | bash', npmCommand: 'npm install -g @anthropic-ai/claude-code', docsUrl: 'https://code.claude.com/docs/en/setup' },
  },
  { stage: 'auth', state: 'skipped', detail: 'Skipped: Claude CLI failed' },
  { stage: 'request', state: 'skipped', detail: 'Skipped: Claude CLI failed' },
  { result: 'failed', stage: 'cli', failed: 'claude_not_found', summary: 'Failed at Claude CLI: The claude CLI was not found on PATH.', ms: 2, via },
]

/** The real envman message for a machine where `envman login` never ran (test-only). */
const SIGNED_OUT_HINT = 'envman is not signed in for the user webterm runs as. Sign in, then Check again.'
export const CONN_WRAPPER_SIGNED_OUT: (StageEvent | FinalEvent)[] = [
  {
    stage: 'wrapper', state: 'failed', ms: 300,
    detail: "envman exited with code 1: need auth to fetch claude:x — not logged in: run 'envman login <server> --token <token>'",
    hint: SIGNED_OUT_HINT, signIn: { tool: 'envman', hint: SIGNED_OUT_HINT, command: 'envman login <server> --token <token>' },
  },
  { stage: 'cli', state: 'skipped', detail: 'Skipped: Wrapper failed' },
  { stage: 'auth', state: 'skipped', detail: 'Skipped: Wrapper failed' },
  { stage: 'request', state: 'skipped', detail: 'Skipped: Wrapper failed' },
  { result: 'failed', stage: 'wrapper', failed: 'wrapper_signed_out', summary: 'Failed at Wrapper: envman exited with code 1', ms: 300, via: 'envman' },
]

/** What the token-free check (`{ request: false }`) streams for a full run's lines: same up to the request, which stays pending. */
export function withoutRequest(lines: (StageEvent | FinalEvent)[]): (StageEvent | FinalEvent)[] {
  const final = lines[lines.length - 1] as FinalEvent
  if (final.result === 'failed' && final.stage !== 'request') return lines
  return [
    ...lines.filter((l) => 'state' in l && l.stage !== 'request'),
    { stage: 'request', state: 'pending', detail: 'Not tested yet — press Test connection to send a test request' },
    { result: 'ready', summary: 'Ready to test — the last check sends one small request', ms: 200, via: final.via },
  ]
}

const ndjson = (lines: unknown[]): Response => new Response(lines.map((l) => `${JSON.stringify(l)}\n`).join(''), { status: 200 })

function capsView(s: FakeServer): CapabilitiesResponse {
  return {
    capabilities: CAPABILITY_IDS.map((id) => ({ id, title: CAPABILITIES[id].title, blurb: CAPABILITIES[id].blurb, status: s.on.has(id) ? 'on' : 'off' })),
    advanced: {
      agentEngine: { value: 'auto', detected: 'claude' },
      chromiumPath: {
        value: s.chromiumValue, detected: s.candidates.length > 0, active: s.chromiumValue || s.candidates[0] || null,
        source: s.chromiumValue ? 'override' : s.candidates.length ? 'auto' : null, overrideInvalid: false, candidates: s.candidates,
      },
      dataDir: '/data',
      ...s.extras,
    } as CapabilitiesResponse['advanced'],
  }
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status })

/** Install the fake as global `fetch`; returns its mutable state. */
export function fakeServer(over: Partial<FakeServer> = {}): FakeServer {
  const s: FakeServer = {
    calls: [], on: new Set(), candidates: ['/usr/bin/google-chrome'], chromiumValue: '', launch: READY, connection: CONN_OK, capsFail: 0, postFail: false, extras: {}, download: DL_IDLE, downloadFail: false,
    provider: { provider: { mode: 'login', secretSet: false, ready: true }, lastTest: null, restartNeeded: 0 }, providerSaveFail: false, ...over,
  }
  vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = String(input)
    const method = (init.method ?? 'GET').toUpperCase()
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined
    s.calls.push({ url, method, body })
    if (url.startsWith('/api/claude-launch/test')) return s.launch === 'error' ? json({ error: 'probe_failed' }, 500) : json(s.launch)
    if (url.startsWith('/api/claude-provider/detect')) return json({ wrappers: [] })
    if (url === '/api/claude-provider/test') return s.connection === 'error' ? json({ error: 'probe_failed' }, 500)
      : ndjson((body as { request?: boolean } | undefined)?.request === false ? withoutRequest(s.connection) : s.connection)
    if (url.startsWith('/api/claude-provider') && method === 'PUT' && s.providerSaveFail) { s.providerSaveFail = false; return json({ error: 'write_failed' }, 500) }
    if (url.startsWith('/api/claude-provider')) return json(s.provider)
    if (url.startsWith('/api/settings/env')) return json(method === 'GET' ? { entries: [{ key: 'WEBTERM_BROWSER_HEADLESS', kind: 'flag', group: 'browser', label: 'Headless mode', value: '', default: 'off' }], locked: false } : {})
    if (url.startsWith('/api/capabilities/chromium-download')) {
      if (s.downloadFail) { s.downloadFail = false; return json({ error: 'boom' }, 500) }
      if (method === 'POST') s.download = url.endsWith('/cancel') ? DL_IDLE : { ...DL_IDLE, state: 'downloading' }
      return json(s.download, method === 'POST' && !url.endsWith('/cancel') ? 202 : 200)
    }
    if (url === '/api/capabilities/advanced' && method === 'PUT') { s.chromiumValue = (body as { chromiumPath: string }).chromiumPath; return json(capsView(s)) }
    if (url.startsWith('/api/capabilities') && method === 'GET') return s.capsFail-- > 0 ? json({ error: 'boom' }, 500) : json(capsView(s))
    const m = /^\/api\/capabilities\/(\w+)$/.exec(url)
    if (m && method === 'POST') {
      if (s.postFail) { s.postFail = false; return json({ error: 'write_failed' }, 500) }
      const id = m[1] as CapabilityId
      if ((body as { enabled: boolean }).enabled) closure(id).forEach((c) => s.on.add(c))
      else [id, ...dependents(id)].forEach((c) => s.on.delete(c))
      return json(capsView(s))
    }
    return json({ builtin: '/home/u/webterm/projects', parent: '/home/u/webterm/projects' })
  }))
  return s
}

/** Capability POSTs as `id=on|off`, in call order. */
export const capabilityWrites = (s: FakeServer): string[] =>
  s.calls.filter((c) => c.method === 'POST' && /^\/api\/capabilities\/\w+$/.test(c.url) && c.url !== '/api/capabilities/advanced')
    .map((c) => `${c.url.split('/').pop()}=${(c.body as { enabled: boolean }).enabled ? 'on' : 'off'}`)
