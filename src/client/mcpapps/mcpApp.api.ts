// Same-origin client of `/api/mcpapps` (src/server/mcpapps/mcpApp.route.ts) for the App node. Every
// failure throws one Error naming the operation and the server's reason.

const PATH = '/api/mcpapps'

async function call<T>(op: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit | undefined = body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  const res = await fetch(path, init)
  const out = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) {
    const e = new Error(`${op}: ${out.error ?? `HTTP ${res.status}`}`)
    ;(e as { status?: number }).status = res.status
    throw e
  }
  return out
}

export interface AppView {
  id: string
  uri: string
  ownerNodeId: string
  /** The policy already embedded in `html`; shown for transparency. */
  csp: string
  html: string
  permissions: string[]
  prefersBorder?: boolean
  toolInput?: Record<string, unknown>
  toolResult?: Record<string, unknown>
}

export const fetchAppView = (id: string): Promise<AppView> => call('Load app', `${PATH}/${encodeURIComponent(id)}`)

export const callAppTool = (id: string, name: string, args: Record<string, unknown>): Promise<unknown> =>
  call(`Call ${name}`, `${PATH}/${encodeURIComponent(id)}/call`, { name, arguments: args })

export const claimApps = (nodeIds: string[]): Promise<{ apps: { id: string; ownerNodeId: string; uri: string }[] }> =>
  call('Find new apps', `${PATH}/claim`, { nodeIds })
