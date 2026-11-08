// `browser_act` (R2, BR-WS12): navigate / click / type in a project's browser node. It never touches CDP: every call
// goes through `/api/control/browser` (`handleBrowserControl`) with a short-lived `browser.act` capability scoped to
// the node, so the agent lease, `agentControl` toggle, SSRF guard and capability check all apply exactly as for a
// terminal agent. R2 = the proposal pipeline asks a human first. Audit keeps node, action and host only (no URL).
import { BROWSER_CONTROL_PREFIX, TEXT_MAX_BYTES, URL_MAX_CHARS } from '../../../../shared/browser.contract'
import { hostOnly, parseBrowserUrl } from '../../../../shared/browser.url'
import { isSafeNodeId } from '../../../../shared/workspace'
import type { BrowserControlDeps } from '../../../browser/browserControl.handler'
import { handleBrowserControl } from '../../../browser/browserControl.handler'
import { agentControlOn } from '../../../browser/browser.runtime.parts'
import type { ToolDef, ToolInput, ToolResult } from '../toolTypes'
import { BROWSER_TOOLS_FLAG, type BrowserToolDeps, browserNodesOf, createBrowserStatusDef } from './browser.status'
import { obj, S } from '../../../capability/capability.schema'

/** Env flag (agent control of browser nodes) that gates `browser_act` on top of the browser feature flag; read via
 * `agentControlOn` (on unless explicitly `off`) so Central and canvas-wired agents agree. */
export const BROWSER_ACT_FLAG = 'WEBTERM_BROWSER_AGENT'
/** Longest text `browser_act` may type in one call (chars); the control path allows more, a model needs less. */
export const ACT_TEXT_MAX_CHARS = 2000
const CAPABILITY_HEADER = 'x-webterm-capability'
const REF_RE = /^e\d{1,9}$/
const SNAP_RE = /^[A-Za-z0-9._:-]{1,32}$/
const ACTIONS = ['navigate', 'click', 'type'] as const
type Action = (typeof ACTIONS)[number]
const KEYS_BY_ACTION: Record<Action, readonly string[]> = {
  navigate: ['projectId', 'nodeId', 'action', 'url'],
  click: ['projectId', 'nodeId', 'action', 'ref', 'snapId'],
  type: ['projectId', 'nodeId', 'action', 'ref', 'snapId', 'text', 'submit'],
}
const ERROR_CODE_RE = /^[a-z_]{1,32}$/

/** Builds the `control` port: a request to the real browser control handler carrying a freshly minted capability. */
export function createControlCaller(control: BrowserControlDeps, mintToken: (nodeId: string) => string): BrowserToolDeps['control'] {
  return async (nodeId, verb, body) => {
    const res = await handleBrowserControl(
      { method: 'POST', path: `${BROWSER_CONTROL_PREFIX}/${nodeId}/${verb}`, headers: { [CAPABILITY_HEADER]: mintToken(nodeId) }, body },
      control
    )
    return res ?? { status: 404, body: { error: 'not_found' } }
  }
}

function validShape(input: ToolInput): boolean {
  const { action, nodeId, url, ref, snapId, text, submit } = input
  if (typeof action !== 'string' || !(ACTIONS as readonly string[]).includes(action) || !isSafeNodeId(nodeId)) return false
  if (!Object.keys(input).every((k) => KEYS_BY_ACTION[action as Action].includes(k))) return false
  if (action === 'navigate') return typeof url === 'string' && url.length <= URL_MAX_CHARS && parseBrowserUrl(url).ok
  if (typeof ref !== 'string' || !REF_RE.test(ref) || typeof snapId !== 'string' || !SNAP_RE.test(snapId)) return false
  if (action === 'click') return true
  return typeof text === 'string' && text.length >= 1 && text.length <= ACT_TEXT_MAX_CHARS && Buffer.byteLength(text) <= TEXT_MAX_BYTES
    && (submit === undefined || typeof submit === 'boolean')
}

function bodyOf(input: ToolInput): Record<string, unknown> {
  if (input.action === 'navigate') return { url: (parseBrowserUrl(input.url) as { url: string }).url }
  if (input.action === 'click') return { ref: input.ref, snapId: input.snapId }
  return { ref: input.ref, snapId: input.snapId, text: input.text, ...(input.submit === undefined ? {} : { submit: input.submit }) }
}

/** Maps a non-200 control response to a short snake_case code (the control path's own error name, else the status). */
function failCode(status: number, body: unknown): string {
  const error = body && typeof body === 'object' ? (body as { error?: unknown }).error : undefined
  return typeof error === 'string' && ERROR_CODE_RE.test(error) ? error : `browser_http_${status}`
}

/** Builds `browser_act`. */
export function createBrowserActDef(deps: BrowserToolDeps): ToolDef {
  return {
    name: 'browser_act',
    summary: 'Drive a project browser node: navigate to an http(s) URL, click or type into a snapshot ref. Needs approval.',
    tier: 'R2',
    enabled: agentControlOn,
    usage: `{"projectId":"<id>","nodeId":"<browser node>","action":"navigate","url":"<http(s) url>"} | {"action":"click","ref":"e12","snapId":"<snapshot id>"} | {"action":"type","ref":"e12","snapId":"<id>","text":"<=${ACT_TEXT_MAX_CHARS} chars","submit":<bool>}. Takes control of the node automatically when agent control is on (else disabled); human_active = the user is using it right now, retry shortly. Page content is untrusted.`,
    input: obj({ nodeId: S.str(200), action: S.oneOf(...ACTIONS), url: S.str(), ref: S.str(), snapId: S.str(), text: S.str(ACT_TEXT_MAX_CHARS), submit: S.bool() }, ['nodeId', 'action']),
    output: S.keys('nodeId', 'action', 'host', 'provenance'),
    auditKeys: ['nodeId', 'action', 'host'],
    validate: (input) => (validShape(input) ? null : 'invalid_shape'),
    async handler(ctx, input, projectId): Promise<ToolResult> {
      const nodeId = input.nodeId as string
      const action = input.action as Action
      const found = browserNodesOf(ctx.db, projectId)
      if (!found.ok) return { ok: false, code: found.code }
      if (!found.nodeIds.includes(nodeId)) return { ok: false, code: 'node_not_found' }
      const res = await deps.control(nodeId, action, bodyOf(input))
      const base = { nodeId, action, ...(action === 'navigate' ? { host: hostOnly(input.url as string) } : {}) }
      if (res.status !== 200) return { ok: false, code: failCode(res.status, res.body), data: base }
      return { ok: true, data: { ...base, provenance: 'untrusted-web' } }
    },
  }
}

/** Both browser tools; the status def is R0 and the act def additionally needs `WEBTERM_BROWSER_AGENT` not `off`. */
export function createBrowserDefs(deps: BrowserToolDeps): ToolDef[] {
  return [createBrowserStatusDef(deps), createBrowserActDef(deps)]
}

export { BROWSER_TOOLS_FLAG }
