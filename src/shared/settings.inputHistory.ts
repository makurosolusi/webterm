// `inputHistory`: values the user typed into a settings combobox, per field id, most recent first.
// Stored server-side (settings document) so they follow the user to other devices. Never holds
// secrets: password fields do not remember (SettingsCombobox `remember={false}`).

export const INPUT_HISTORY_LIMITS = { values: 10, fields: 50, valueLength: 512 } as const

const FIELD_ID = /^[A-Za-z0-9._-]{1,64}$/

export const isInputHistoryFieldId = (id: string): boolean => FIELD_ID.test(id)

/** One value as stored (trimmed), or null when empty, not a string, or too long. */
export function normalizeHistoryValue(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t && t.length <= INPUT_HISTORY_LIMITS.valueLength ? t : null
}

/** A list normalized: valid values only, deduped (first wins), capped. */
export function normalizeHistoryList(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  const out: string[] = []
  for (const x of v) {
    const n = normalizeHistoryValue(x)
    if (n !== null && !out.includes(n)) out.push(n)
    if (out.length >= INPUT_HISTORY_LIMITS.values) break
  }
  return out
}

/** `value` moved to the front of `list` (deduped, capped); an invalid value leaves `list` as is. */
export function pushHistory(list: readonly string[], value: string): string[] {
  const n = normalizeHistoryValue(value)
  if (n === null) return [...list]
  return [n, ...list.filter((x) => x !== n)].slice(0, INPUT_HISTORY_LIMITS.values)
}

/** The whole map normalized (load and PUT): bad ids and empty lists dropped; past the field cap the
 *  oldest-created fields go (a patch appends new ids at the end). */
export function normalizeInputHistory(v: unknown): Record<string, string[]> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
  const entries = Object.entries(v)
    .filter(([id]) => isInputHistoryFieldId(id))
    .map(([id, list]) => [id, normalizeHistoryList(list)] as const)
    .filter(([, list]) => list.length > 0)
  return Object.fromEntries(entries.slice(-INPUT_HISTORY_LIMITS.fields))
}

/**
 * Strict check of a PATCH's `inputHistory` (entry patch: `null` deletes a field). A list must already
 * be in stored form (trimmed, unique, within limits), so a broken client is refused (400), not
 * silently rewritten. Errors carry position and code only: no value is echoed back.
 */
export function inputHistoryPatchErrors(v: unknown): { index: number; field: string; code: string }[] {
  if (v === undefined) return []
  if (!v || typeof v !== 'object' || Array.isArray(v)) return [{ index: -1, field: 'inputHistory', code: 'not_object' }]
  const entries = Object.entries(v)
  if (entries.length > INPUT_HISTORY_LIMITS.fields) return [{ index: -1, field: 'inputHistory', code: 'too_many_fields' }]
  return entries.flatMap(([id, list], index) => {
    if (!isInputHistoryFieldId(id)) return [{ index, field: 'inputHistory.id', code: 'invalid_id' }]
    if (list === null) return []
    const exact = Array.isArray(list) && list.length > 0 && list.length <= INPUT_HISTORY_LIMITS.values
      && JSON.stringify(normalizeHistoryList(list)) === JSON.stringify(list)
    return exact ? [] : [{ index, field: 'inputHistory.list', code: 'invalid_list' }]
  })
}
