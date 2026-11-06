// Client side of /api/templates (src/server/templates/template.route.ts): product text, the request
// helper and what the instantiate form must show before anything runs.
import type { BridgeLink, Workspace, WsNode } from '../../shared/workspace'
import type { WebtermTemplate } from '../../server/templates/template.model'

export type { WebtermTemplate }
export const TEMPLATES_API = '/api/templates'

export const TEMPLATES_TEXT = {
  newCommand: 'Workspace: New from Template…',
  saveCommand: 'Workspace: Save as Template…',
  pickTitle: 'New from template',
  pickIntro: 'Start a canvas setup: nodes, cables, launch commands, notes, routines and a plan skeleton.',
  builtin: 'Built-in',
  empty: 'No templates yet.',
  import: 'Import…',
  export: 'Export',
  remove: 'Delete',
  back: 'Back',
  target: 'Create in',
  targetNew: 'New workspace',
  targetActive: 'This workspace',
  workspaceName: 'Workspace name',
  commands: 'These commands will run when the nodes start:',
  routines: 'Routines (created paused; turn them on in Routines after review):',
  worktrees: (n: number) => `${n} node${n === 1 ? '' : 's'} get their own git worktree (setup scripts are not run).`,
  create: 'Create',
  creating: 'Creating…',
  routinesSkipped: (n: number) => `${n} routine${n === 1 ? ' was' : 's were'} skipped: the ledger is off.`,
  saveTitle: 'Save as template',
  saveIntro: 'Saves this canvas: node kinds and layout, cables, launch commands, agent kinds, notes, the plan skeleton and routines. Session ids, transcripts, tokens, secrets and absolute paths are left out.',
  name: 'Template name',
  description: 'Description',
  includeRoutines: "Include this workspace's routines",
  save: 'Save',
  saved: (name: string) => `Saved "${name}". Export it to share as a JSON file.`,
  importFailed: (msg: string) => `Import rejected: ${msg}`,
} as const

/** JSON request; a non-2xx answer throws with the server's message. */
export async function templatesRequest<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const out: unknown = res.status === 204 ? null : await res.json().catch(() => null)
  if (!res.ok) {
    const e = (out ?? {}) as { message?: string; error?: string }
    throw new Error(e.message ?? e.error ?? `${method} ${path} failed (${res.status})`)
  }
  return out as T
}

export const listTemplates = () => templatesRequest<{ templates: WebtermTemplate[] }>('GET', TEMPLATES_API).then((r) => r.templates)
export const saveTemplate = (workspaceId: string, name: string, description: string, includeRoutines: boolean) =>
  templatesRequest<{ template: WebtermTemplate }>('POST', TEMPLATES_API, { workspaceId, name, description, includeRoutines }).then((r) => r.template)
export const importTemplate = (file: unknown) => templatesRequest<{ template: WebtermTemplate }>('POST', `${TEMPLATES_API}/import`, file).then((r) => r.template)
export const deleteTemplate = (id: string) => templatesRequest<null>('DELETE', `${TEMPLATES_API}/${encodeURIComponent(id)}`)

export interface RoutineCounts { created: number; skipped: number }
export type Instantiated =
  | { workspace: Workspace; routines: RoutineCounts }
  | { workspaceId: string; nodes: WsNode[]; bridges: BridgeLink[]; routines: RoutineCounts }

export const instantiate = (id: string, params: Record<string, string>, target: { workspaceId: string } | { name: string }) =>
  templatesRequest<Instantiated>('POST', `${TEMPLATES_API}/${encodeURIComponent(id)}/instantiate`, { params, ...target })

/** What will execute, shown before Create: launch commands and routine prechecks, verbatim. */
export function reviewOf(t: WebtermTemplate): { commands: string[]; routines: string[]; worktrees: number } {
  return {
    commands: [...new Set(t.nodes.flatMap((n) => (n.cmd ? [n.cmd] : [])))],
    routines: t.routines.map((r) => (r.precheck ? `${r.name} (precheck: ${r.precheck.command})` : r.name)),
    worktrees: t.nodes.filter((n) => n.worktree).length,
  }
}

/** Starts a JSON download of `t` (Export). */
export function downloadTemplate(t: WebtermTemplate): void {
  const { builtin: _b, ...file } = t
  const url = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `${t.id}.webterm-template.json`
  a.click()
  URL.revokeObjectURL(url)
}
