// User templates live in webterm.db's existing key/value `app` table, one JSON row per template under
// `template:<id>` (the same pattern db.ts uses for `settings`): zero schema migration, and the ledger
// is not needed. Built-ins are code, never rows.
import type { Database } from 'bun:sqlite'
import { BUILTIN_TEMPLATES } from './template.builtins'
import { TemplateError, validateTemplate, type WebtermTemplate } from './template.model'

const PREFIX = 'template:'
/** List cap: templates are hand-made, a few dozen at most. */
export const TEMPLATE_LIST_MAX = 200

export interface TemplateStore {
  list(): WebtermTemplate[]
  get(id: string): WebtermTemplate | null
  /** Validates, then inserts or replaces; a built-in id is refused. */
  put(raw: unknown): WebtermTemplate
  delete(id: string): boolean
}

export function createTemplateStore(d: Database): TemplateStore {
  d.exec('CREATE TABLE IF NOT EXISTS app (key TEXT PRIMARY KEY, value TEXT);')
  const builtin = (id: string) => BUILTIN_TEMPLATES.find((t) => t.id === id) ?? null
  const parse = (value: string): WebtermTemplate | null => {
    try {
      return validateTemplate(JSON.parse(value))
    } catch (e) {
      // A row that no longer validates (hand-edited DB, older shape) is skipped, not served.
      if (e instanceof TemplateError || e instanceof SyntaxError) return null
      throw e
    }
  }
  return {
    list() {
      const rows = d.query('SELECT value FROM app WHERE key LIKE ? ORDER BY key LIMIT ?').all(`${PREFIX}%`, TEMPLATE_LIST_MAX) as { value: string }[]
      return [...BUILTIN_TEMPLATES, ...rows.flatMap((r) => parse(r.value) ?? [])]
    },
    get(id) {
      const row = d.query('SELECT value FROM app WHERE key = ?').get(PREFIX + id) as { value: string } | null
      return builtin(id) ?? (row ? parse(row.value) : null)
    },
    put(raw) {
      const t = validateTemplate(raw)
      if (builtin(t.id)) throw new TemplateError('builtin_readonly', `${t.id} is a built-in template; import it under another id`)
      d.query('INSERT INTO app (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(PREFIX + t.id, JSON.stringify(t))
      return t
    },
    delete(id) {
      if (builtin(id)) throw new TemplateError('builtin_readonly', `${id} is a built-in template`)
      // The local bun:sqlite shim types `run` as void; at runtime it reports `changes`.
      const r = d.query('DELETE FROM app WHERE key = ?').run(PREFIX + id) as unknown as { changes?: number } | undefined
      return (r?.changes ?? 0) > 0
    },
  }
}
