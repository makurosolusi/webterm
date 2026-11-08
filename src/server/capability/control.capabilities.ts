// Control-plane verbs (`/api/control/*`) declared as capabilities. This list is the single source of
// `CAPABILITY_VERBS` (control/capabilities.ts); the route modules stay the handlers, bound by `route`.
// capability.drift.test.ts checks every route here resolves in the real control router.
import { BROWSER_CONTROL_PREFIX, BROWSER_VERB_CAP, URL_MAX_CHARS, VIEWPORT_MAX, WAIT_MAX_MS } from '../../shared/browser.contract'
import { CONTROL_PREFIX } from '../control/controlTypes'
import { CONSOLE_BUFFER_MAX, CONSOLE_LEVELS } from '../../shared/browser.console'
import { defineCapability, type CapabilitySpec } from './capability.define'
import { obj, S, type JsonSchema } from './capability.schema'

const nodeId = S.str(200)
const requestId = S.str(200, { description: 'Idempotency key; a repeat with the same key replays the first answer.' })
const ack = obj({ ok: S.bool(), requestId: S.str(), nodeId: S.str() }, ['ok'])
const verbsOf = (cap: 'browser.read' | 'browser.act'): string[] => Object.keys(BROWSER_VERB_CAP).filter((v) => BROWSER_VERB_CAP[v as keyof typeof BROWSER_VERB_CAP] === cap)
const http = (method: 'GET' | 'POST', path: string) => ({ method, path: `${CONTROL_PREFIX}${path}` }) as const
const browserRoute = { method: 'POST', path: `${BROWSER_CONTROL_PREFIX}/:nodeId/:verb` } as const
// Per-verb args (shared/browser.contract.ts VerbBodies), flat: MCP clients reject a top-level anyOf, so
// each property names the verb(s) it belongs to and the verb handler enforces which are required.
const ref = S.str(16, { pattern: '^e\\d+$', description: 'click, type: element ref from the latest snapshot (e12).' })
const snapId = S.str(200, { description: 'click, type: snapId of the snapshot the ref came from.' })
const browserReadArgs: Record<string, JsonSchema> = {
  maxWidth: { ...S.int(1, VIEWPORT_MAX), description: 'screenshot: max width in px.' },
  ms: { ...S.int(0, WAIT_MAX_MS), description: 'wait: timeout (or plain sleep) in ms.' },
  selectorRef: S.str(16, { pattern: '^e\\d+$', description: 'wait: until this snapshot ref is rendered.' }),
  loaded: { type: 'boolean', const: true, description: 'wait: until the page finished loading.' },
  limit: { ...S.int(1, CONSOLE_BUFFER_MAX), description: 'console: newest entries to return (default 50).' },
  level: { ...S.oneOf(...CONSOLE_LEVELS), description: 'console: minimum level (default info).' },
}
const browserActArgs: Record<string, JsonSchema> = {
  url: S.str(URL_MAX_CHARS, { description: 'navigate: absolute URL.' }),
  ref, snapId,
  text: S.str(undefined, { description: 'type: text inserted at the caret.' }),
  submit: { ...S.bool(), description: 'type: press Enter after typing.' },
  key: S.str(16, { description: 'press: key name (Enter, Tab, Escape, Backspace, Delete, a space, ArrowUp/Down/Left/Right, PageUp, PageDown, Home, End).' }),
  dy: { type: 'number', description: 'scroll: vertical pixels, non-zero (negative scrolls up).' },
}

const CONTROL = [
  defineCapability({
    name: 'node.spawn', summary: 'Start a PTY agent session for a canvas node from a configured launch command.',
    tier: 'R2', scope: 'node', projections: ['control-http'], idempotent: true, route: http('POST', '/spawn'),
    input: obj({ requestId, nodeId, agentId: S.str(200), cwd: S.str(4096), cols: S.int(1, 500), rows: S.int(1, 500), sessionId: S.str(200) }, ['requestId', 'nodeId', 'agentId']),
    output: ack,
  }),
  defineCapability({
    name: 'node.prompt', summary: 'Type text into a live node session, submitting it unless submit is false.',
    tier: 'R1', scope: 'node', projections: ['control-http'], idempotent: true, route: http('POST', '/prompt'),
    input: obj({ requestId, nodeId, text: S.str(), submit: S.bool() }, ['requestId', 'nodeId', 'text']),
    output: ack,
  }),
  defineCapability({
    name: 'node.wait', summary: 'Block until a node exits, goes idle or reports done, bounded by timeoutMs.',
    tier: 'R0', scope: 'node', projections: ['control-http'], idempotent: true, route: http('POST', '/wait'),
    input: obj({ nodeId, until: S.oneOf('exit', 'idle', 'status:done'), timeoutMs: S.int(0) }, ['nodeId']),
    output: S.anyObj('Observation: exit, status and output tail.'),
  }),
  defineCapability({
    name: 'node.close', summary: 'Close a node session; closing a node that is already gone is a no-op.',
    tier: 'R2', scope: 'node', projections: ['control-http'], idempotent: true, route: http('POST', '/close'),
    input: obj({ requestId, nodeId }, ['requestId', 'nodeId']),
    output: obj({ ok: S.bool(), requestId: S.str(), nodeId: S.str(), closed: S.bool() }, ['ok']),
  }),
  defineCapability({
    name: 'node.read', summary: 'List the live node sessions this capability may see.',
    tier: 'R0', scope: 'node', projections: ['control-http'], idempotent: true, route: http('GET', '/nodes'),
    input: obj({}), output: S.anyObj('Array of sessions (JSON array body).'),
  }),
  defineCapability({
    name: 'plan.read', summary: 'Read the plan for the granted resource (not available yet: answers 501).',
    tier: 'R0', scope: 'project', projections: ['control-http'], idempotent: true, route: http('GET', '/plan'),
    input: obj({}), output: S.anyObj(),
  }),
  defineCapability({
    name: 'approval.request', summary: 'Ask a human to approve a request; returns a pending approval challenge.',
    tier: 'R1', scope: 'project', projections: ['control-http'], idempotent: true, route: http('POST', '/approval/request'),
    input: obj({ requestId, projectId: S.str(200), kind: S.str(100), request: S.anyObj(), ttlMs: S.int(1), taskId: S.str(200) }, ['requestId', 'projectId', 'kind', 'request']),
    output: S.anyObj('Approval challenge: id, digest, nonce, expiresAt.'),
  }),
  defineCapability({
    name: 'approval.decide', summary: 'Record a human decision on a pending approval with its digest and nonce.',
    tier: 'R2', scope: 'project', projections: ['control-http'], idempotent: true, route: http('POST', '/approval/decide'),
    input: obj({ requestId, id: S.str(200), approve: S.bool(), digest: S.str(), nonce: S.str(), actor: S.str(200) }, ['requestId', 'id', 'approve', 'digest', 'nonce', 'actor']),
    output: S.anyObj(),
  }),
  defineCapability({
    name: 'approval.consume', summary: 'Consume an approved approval exactly once before running the approved action.',
    tier: 'R2', scope: 'project', projections: ['control-http'], idempotent: true, route: http('POST', '/approval/consume'),
    input: obj({ requestId, id: S.str(200), digest: S.str() }, ['requestId', 'id', 'digest']),
    output: obj({ ok: S.bool(), requestId: S.str(), id: S.str(), consumed: S.bool() }, ['ok']),
  }),
  defineCapability({
    name: 'approval.read', summary: 'List approvals of a project, optionally by status.',
    tier: 'R0', scope: 'project', projections: ['control-http'], idempotent: true, route: http('GET', '/approval/list'),
    input: obj({ projectId: S.str(200), status: S.str(), limit: S.int(1) }, ['projectId']),
    output: S.anyObj(),
  }),
  defineCapability({
    name: 'browser.read', summary: 'Read a browser node: status, snapshot, screenshot, wait or console.',
    tier: 'R0', scope: 'node', projections: ['control-http'], idempotent: true, route: browserRoute,
    input: obj({ nodeId, verb: S.oneOf(...verbsOf('browser.read')), ...browserReadArgs }, ['verb']),
    output: S.anyObj('Verb data (browser.contract.ts VerbData).'),
  }),
  defineCapability({
    name: 'browser.act', summary: 'Drive a browser node: navigate, click, type, press, scroll or release.',
    tier: 'R1', scope: 'node', projections: ['control-http'], route: browserRoute,
    input: obj({ nodeId, verb: S.oneOf(...verbsOf('browser.act')), ...browserActArgs }, ['verb']),
    output: S.anyObj('Verb data (browser.contract.ts VerbData).'),
  }),
] as const satisfies readonly CapabilitySpec[]

/** Control capabilities in declaration order. */
export const CONTROL_CAPABILITIES: readonly CapabilitySpec[] = CONTROL
/** Verb names grantable by a control capability token. */
export type ControlVerb = (typeof CONTROL)[number]['name']
export const CONTROL_VERBS: readonly ControlVerb[] = CONTROL.map((c) => c.name)
