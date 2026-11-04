// CSP for an MCP Apps view (SEP-1865, spec 2026-01-26, `_meta.ui.csp`). Directive set copied from
// the ext-apps reference host (examples/basic-host/serve.ts `buildCspHeader`) with one deliberate
// tightening the spec allows ("hosts may restrict further"): no `'self'`. The view runs in an
// opaque-origin srcdoc frame, so `'self'` buys nothing for the app and could only ever point back
// at the webterm origin; declared domains are the only network the view gets.

/** `_meta.ui.csp` of a `ui://` resource content item. */
export interface McpAppCsp {
  connectDomains?: string[]
  resourceDomains?: string[]
  frameDomains?: string[]
  baseUriDomains?: string[]
}

/**
 * Domain entries that cannot break out of their directive (reference `sanitizeCspDomains`): `;` or a
 * newline would start a new directive, a quote would inject a keyword like 'unsafe-eval', a space
 * would smuggle several sources into one entry.
 */
export function cleanCspDomains(domains: unknown): string[] {
  if (!Array.isArray(domains)) return []
  return domains.filter((d): d is string => typeof d === 'string' && d !== '' && !/[;\r\n'" ,]/.test(d))
}

/** The policy string for one view; an absent `csp` gives the spec default (no network at all). */
export function buildAppCsp(csp?: McpAppCsp): string {
  const res = cleanCspDomains(csp?.resourceDomains).join(' ')
  const connect = cleanCspDomains(csp?.connectDomains).join(' ')
  const frame = cleanCspDomains(csp?.frameDomains).join(' ')
  const base = cleanCspDomains(csp?.baseUriDomains).join(' ')
  const src = (name: string, fixed: string, extra: string) => `${name} ${fixed} ${extra}`.trim()
  return [
    "default-src 'none'",
    src('script-src', "'unsafe-inline' 'unsafe-eval' blob: data:", res),
    src('style-src', "'unsafe-inline' blob: data:", res),
    src('img-src', 'data: blob:', res),
    src('font-src', 'data: blob:', res),
    src('media-src', 'data: blob:', res),
    connect ? `connect-src ${connect}` : "connect-src 'none'",
    src('worker-src', 'blob:', res),
    frame ? `frame-src ${frame}` : "frame-src 'none'",
    "object-src 'none'",
    base ? `base-uri ${base}` : "base-uri 'none'",
    "form-action 'none'",
  ].join('; ')
}

const attr = (s: string): string => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

/**
 * `html` with the policy as the very first bytes. The reference host sets CSP as an HTTP header on a
 * second origin; webterm has one origin and an iframe URL there would need the transport token, so
 * the view is a srcdoc and the policy rides a `<meta http-equiv>` placed before anything the resource
 * wrote: no script of the view can run before it applies, and removing the element later does not
 * lift an applied policy. A leading doctype stays first (it carries no script) so the view keeps
 * standards mode.
 */
export function withCspMeta(html: string, csp: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${attr(csp)}">`
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html)?.[0] ?? ''
  return `${doctype}${meta}${html.slice(doctype.length)}`
}
