// Pure rows of Settings › Keyboard Shortcuts (SettingsKeybindings.tsx), VS Code's Keyboard Shortcuts
// editor: which commands are listed, their When / Source cells, the text / record-keys / conflict
// filters and the column sort. React-free so the table rules are tested without rendering.
import { chordLabel, commandCategory, type Command, type CommandScope } from './commandRegistry'
import { effectiveBindings, type EffectiveBinding } from './keybindings.resolve'
import type { KeybindingOverrides } from './keybindings.store'
import { matchesSearch } from './SettingsFields'

/** VS Code's Source column: a binding is either the shipped Default or the User's. */
export type SourceLabel = 'Default' | 'User'
export const sourceLabel = (b: EffectiveBinding): SourceLabel => (b.source === 'user' ? 'User' : 'Default')

/** Plain-English When for a scope; a global binding has no condition (VS Code leaves When empty). */
const SCOPE_WHEN: Record<CommandScope, string> = {
  global: '',
  editor: 'Editor node focused',
  terminal: 'Terminal focused',
  files: 'Files node focused',
  canvas: 'Canvas focused',
  browser: 'Browser node focused',
}
export const whenOf = (cmd: Command): string => cmd.when ?? SCOPE_WHEN[cmd.scope ?? 'global']

export type SortColumn = 'command' | 'keybinding' | 'source'
export interface Sort { column: SortColumn; dir: 'ascending' | 'descending' }

export interface RowFilter {
  /** Normalised text query (`normalizeQuery`). */
  text: string
  /** Record-keys search: only rows bound to exactly this chord. */
  chord: string | null
  /** Only rows that share their chord with another command. */
  conflictsOnly: boolean
}

/** Bindable commands, grouped by category (the default order) or sorted by one column. */
export function keybindingRows(list: readonly Command[], overrides: KeybindingOverrides, sort: Sort | null, isMac: boolean): EffectiveBinding[] {
  const rows = effectiveBindings(list.filter((c) => c.bindable !== false), overrides)
  if (!sort) {
    const byCategory = new Map<string, EffectiveBinding[]>()
    for (const b of rows) {
      const cat = commandCategory(b.cmd)
      byCategory.set(cat, [...(byCategory.get(cat) ?? []), b])
    }
    return [...byCategory.keys()].sort().flatMap((cat) => byCategory.get(cat)!)
  }
  // Unbound rows sort after every chord in both directions, as in VS Code.
  const keyOf = (b: EffectiveBinding): string => (sort.column === 'command' ? b.cmd.label
    : sort.column === 'source' ? sourceLabel(b) : b.key ? chordLabel(b.key, isMac) : '')
  const sign = sort.dir === 'ascending' ? 1 : -1
  return [...rows].sort((a, b) => {
    const ka = keyOf(a)
    const kb = keyOf(b)
    if (!ka !== !kb) return ka ? -1 : 1
    return sign * ka.localeCompare(kb) || a.cmd.label.localeCompare(b.cmd.label)
  })
}

/** Rows passing every active filter; `clashes` is `findConflicts` over the same list. */
export function filterRows(rows: readonly EffectiveBinding[], f: RowFilter, clashes: ReadonlyMap<string, string[]>, isMac: boolean): EffectiveBinding[] {
  return rows.filter((b) => {
    if (f.conflictsOnly && !clashes.has(b.cmd.id)) return false
    if (f.chord !== null) return b.key === f.chord
    const text = `${b.cmd.label} ${commandCategory(b.cmd)} ${b.key ? chordLabel(b.key, isMac) : ''} ${sourceLabel(b)} ${whenOf(b.cmd)} ${b.cmd.id}`
    return matchesSearch(text, f.text)
  })
}

/** Next sort after clicking `column`'s header: ascending, then descending, then back to the grouped default. */
export function nextSort(current: Sort | null, column: SortColumn): Sort | null {
  if (current?.column !== column) return { column, dir: 'ascending' }
  return current.dir === 'ascending' ? { column, dir: 'descending' } : null
}
