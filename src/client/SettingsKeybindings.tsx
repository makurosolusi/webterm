// Settings › Keyboard Shortcuts, imitating VS Code's Keyboard Shortcuts editor: one table (Command |
// Keybinding | When | Source) over every bindable registry command (commandRegistry.ts), a text or
// "Record keys" search, an "N conflicts" filter, sortable columns and a row context menu. Recording
// starts on double-click, Enter or the pencil (Escape cancels); a chord `rejectChord` refuses says why
// in a sub-row, one already in use names the other command with Replace. Overrides go to
// keybindings.store (saved as `keybindings`), so the terminal hand-back (`isAppChord`) and Monaco
// (`editorChords`) follow them as before. Row and pure table rules: SettingsKeybindingRow.tsx,
// settingsKeybindings.model.ts.
import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { IconButton } from '@/components/ui/icon-button'
import { VscodeMenu } from '@/components/vscode/vscodeMenu'
import { chordLabel, eventChord, findConflicts, useCommands, type Command } from './commandRegistry'
import { conflictsFor, rejectChord, type EffectiveBinding } from './keybindings.resolve'
import { resetAllKeybindings, resetKeybinding, setKeybinding, useKeybindingOverrides } from './keybindings.store'
import { FieldSaveStatus, normalizeQuery } from './SettingsFields'
import { KeybindingDetail, KeybindingRow } from './SettingsKeybindingRow'
import { filterRows, keybindingRows, nextSort, type Sort, type SortColumn } from './settingsKeybindings.model'
import { rowMenuItems } from './settingsKeybindings.menu'
import { useFieldSave } from './settingsSave'
import { isMacPlatform } from './terminalKeys.platform'
import { settingsSaves } from './useSettings'
import './commandRegistry.defaults' // the fixed and surface shortcuts are listed even where App is not mounted
import './helpOverlay.css'
import './settings-keybindings.css'

export const KEYS_TEXT = {
  filter: 'Search shortcuts',
  recordKeys: 'Record keys',
  recordKeysHint: 'Press keys to search',
  conflicts: (n: number): string => `${n} conflict${n === 1 ? '' : 's'}`,
  columns: { command: 'Command', keybinding: 'Keybinding', when: 'When', source: 'Source' },
  table: 'Keyboard shortcuts',
  none: (q: string): string => `No shortcuts match “${q}”.`,
  noChord: (chord: string): string => `No commands are bound to ${chord}.`,
  noConflicts: 'No conflicting shortcuts.',
  resetAll: 'Reset all',
  resetAllTitle: 'Reset all keyboard shortcuts?',
  resetAllBody: (n: number): string => `${n} custom ${n === 1 ? 'shortcut goes' : 'shortcuts go'} back to the default.`,
  cancel: 'Cancel',
  menu: 'Keybinding actions',
} as const

/** The settings key whose save state shows a shortcut change. */
const SAVE_KEY = 'keybindings'
const ALL = '*'
const SORTABLE: SortColumn[] = ['command', 'keybinding', 'source']

interface Pending { id: string; chord: string; others: readonly Command[] }

export function KeybindingsSection(): React.JSX.Element {
  const isMac = isMacPlatform()
  const list = useCommands()
  const overrides = useKeybindingOverrides()
  const [query, setQuery] = useState('')
  const [keysMode, setKeysMode] = useState(false)
  const [keysChord, setKeysChord] = useState<string | null>(null)
  const [conflictsOnly, setConflictsOnly] = useState(false)
  const [sort, setSort] = useState<Sort | null>(null)
  const [active, setActive] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ b: EffectiveBinding; anchor: { x: number; y: number } } | null>(null)
  const [recording, setRecording] = useState<string | null>(null)
  const [problem, setProblem] = useState<{ id: string; text: string } | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [edited, setEdited] = useState<string | null>(null)
  const [confirmAll, setConfirmAll] = useState(false)
  const save = useFieldSave(settingsSaves, SAVE_KEY)
  const body = useRef<HTMLDivElement>(null)
  const filterBox = useRef<HTMLInputElement>(null)

  const bindable = useMemo(() => list.filter((c) => c.bindable !== false), [list])
  const rows = useMemo(() => keybindingRows(bindable, overrides, sort, isMac), [bindable, overrides, sort, isMac])
  const clashes = useMemo(() => findConflicts(bindable, overrides), [bindable, overrides])
  const labelOf = (id: string): string => list.find((c) => c.id === id)?.label ?? id
  const shown = filterRows(rows, { text: normalizeQuery(query), chord: keysMode ? keysChord : null, conflictsOnly }, clashes, isMac)
  const custom = Object.keys(overrides).length
  const focusId = shown.some((b) => b.cmd.id === active) ? active : shown[0]?.cmd.id

  const commit = (id: string, chord: string | null): void => { setKeybinding(id, chord); setEdited(id) }
  const reset = (id: string): void => { resetKeybinding(id); setEdited(id) }
  const record = (id: string): void => { setPending(null); setProblem(null); setRecording((r) => (r === id ? null : id)) }

  // Capture phase on window: the recorded key reaches nothing else (not the dispatcher, not the dialog's Escape).
  useEffect(() => {
    if (!recording) return
    const cmd = list.find((c) => c.id === recording)
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') { setRecording(null); setProblem(null); return }
      const chord = eventChord(e, isMac)
      if (!chord || !cmd) return // a bare modifier: keep listening
      const why = rejectChord(chord)
      if (why) { setProblem({ id: cmd.id, text: why }); return }
      setRecording(null)
      setProblem(null)
      const others = conflictsFor(chord, cmd.scope ?? 'global', bindable, overrides).filter((c) => c.id !== cmd.id)
      if (others.length) setPending({ id: cmd.id, chord, others })
      else commit(cmd.id, chord)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recording, list, bindable, overrides, isMac])

  const replace = (p: Pending): void => {
    // Built-in shortcuts belong to their surface and keep their key; every rebindable holder lets go of it.
    for (const o of p.others) if (!o.fixed) setKeybinding(o.id, null)
    commit(p.id, p.chord)
    setPending(null)
  }

  const showSame = (chord: string): void => { setQuery(''); setKeysMode(true); setKeysChord(chord); filterBox.current?.focus() }
  const toggleKeysMode = (): void => { setKeysMode((on) => !on); setKeysChord(null); setQuery(''); filterBox.current?.focus() }

  // Record keys: every keydown in the box is the search, except Tab so focus can still leave.
  const onFilterKey = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (!keysMode || (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey)) return
    e.preventDefault()
    e.stopPropagation()
    const chord = eventChord(e.nativeEvent, isMac)
    if (chord) setKeysChord(chord)
  }

  const rowEl = (id: string): HTMLElement | null => body.current?.querySelector<HTMLElement>(`[role="row"][data-command="${CSS.escape(id)}"]`) ?? null
  const moveTo = (id: string | undefined): void => { if (id) { setActive(id); rowEl(id)?.focus() } }
  // Roving focus (VS Code list): arrows / Home / End move rows; Enter records, Delete removes, Shift+F10 opens the menu.
  const onTableKey = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (recording) return
    const at = shown.findIndex((b) => b.cmd.id === (e.target as Element).closest('[data-command]')?.getAttribute('data-command'))
    if (at < 0) return
    const b = shown[at]
    const go = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: shown.length - 1 }[e.key]
    if (go !== undefined) moveTo(shown[Math.max(0, Math.min(shown.length - 1, go))]?.cmd.id)
    else if (e.key === 'Enter' && (e.target as Element).getAttribute('role') === 'row' && !b.cmd.fixed) record(b.cmd.id)
    else if (e.key === 'Delete' && !b.cmd.fixed && b.key) commit(b.cmd.id, null)
    else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
      const r = rowEl(b.cmd.id)?.getBoundingClientRect()
      setMenu({ b, anchor: { x: r?.left ?? 0, y: r?.bottom ?? 0 } })
    } else return
    e.preventDefault()
  }

  const conflictCount = rows.filter((b) => clashes.has(b.cmd.id)).length
  const emptyText = conflictsOnly && !conflictCount ? KEYS_TEXT.noConflicts
    : keysMode && keysChord ? KEYS_TEXT.noChord(chordLabel(keysChord, isMac)) : KEYS_TEXT.none(query.trim())

  return (
    <div className="st-keybindings" data-slot="settings-keybindings">
      <div className="st-kb-toolbar">
        <input ref={filterBox} type="search" className="st-search st-kb-filter" aria-label={KEYS_TEXT.filter}
          placeholder={keysMode ? KEYS_TEXT.recordKeysHint : KEYS_TEXT.filter} data-record-keys={keysMode ? '' : undefined}
          data-settings-escape={keysMode ? '' : undefined} readOnly={keysMode}
          value={keysMode ? (keysChord ? chordLabel(keysChord, isMac) : '') : query}
          onChange={(e) => setQuery(e.target.value)} onKeyDown={onFilterKey} />
        <IconButton size="icon-xs" label={KEYS_TEXT.recordKeys} aria-pressed={keysMode} onClick={toggleKeysMode}>
          <span className="codicon codicon-record-keys" aria-hidden />
        </IconButton>
        {conflictCount || conflictsOnly ? (
          <button type="button" className="st-button st-kb-chip" aria-pressed={conflictsOnly} onClick={() => setConflictsOnly((on) => !on)}>
            <span className="codicon codicon-warning" aria-hidden="true" />{KEYS_TEXT.conflicts(conflictCount)}
          </button>
        ) : null}
        {custom ? <button type="button" className="st-button" onClick={() => setConfirmAll(true)}>{KEYS_TEXT.resetAll}</button> : null}
        {edited === ALL ? <FieldSaveStatus save={save} /> : null}
      </div>
      <div role="table" aria-label={KEYS_TEXT.table} className="st-kb-table">
        <div role="rowgroup" className="st-kb-sticky">
          <div role="row" className="st-kb-grid st-kb-head">
            {(['command', 'keybinding', 'when', 'source'] as const).map((col) => {
              const sortable = (SORTABLE as string[]).includes(col)
              const dir = sort?.column === col ? sort.dir : 'none'
              return (
                <div key={col} role="columnheader" className="st-kb-cell" aria-sort={sortable ? dir : undefined}>
                  {sortable ? (
                    <button type="button" className="st-kb-sort" onClick={() => setSort((s) => nextSort(s, col as SortColumn))}>
                      {KEYS_TEXT.columns[col]}
                      {dir !== 'none' ? <span className={`codicon codicon-arrow-${dir === 'ascending' ? 'up' : 'down'}`} aria-hidden="true" /> : null}
                    </button>
                  ) : KEYS_TEXT.columns[col]}
                </div>
              )
            })}
          </div>
        </div>
        <div role="rowgroup" ref={body} onKeyDown={onTableKey}>
          {shown.map((b) => {
            const id = b.cmd.id
            return (
              <Fragment key={id}>
                <KeybindingRow b={b} isMac={isMac} focusable={focusId === id} recording={recording === id}
                  clash={clashes.get(id)?.map(labelOf)} onFocus={() => setActive(id)} onRecord={() => record(id)} onReset={() => reset(id)}
                  onMenu={(e) => { e.preventDefault(); setActive(id); setMenu({ b, anchor: { x: e.clientX, y: e.clientY } }) }} />
                <KeybindingDetail cmd={b.cmd} problem={problem?.id === id ? problem.text : null}
                  ask={pending?.id === id ? { chord: chordLabel(pending.chord, isMac), others: pending.others } : null}
                  save={edited === id ? save : undefined} onReplace={() => pending && replace(pending)} onCancel={() => setPending(null)} />
              </Fragment>
            )
          })}
        </div>
      </div>
      {shown.length ? null : <p className="st-no-results" role="status">{emptyText}</p>}
      <VscodeMenu open={menu !== null} anchor={menu?.anchor ?? { x: 0, y: 0 }} ariaLabel={KEYS_TEXT.menu} onClose={() => setMenu(null)}
        items={menu ? rowMenuItems(menu.b, isMac, { record, remove: (id) => commit(id, null), reset, showSame }) : []} />
      {confirmAll ? (
        <AlertDialog open onOpenChange={(open) => { if (!open) setConfirmAll(false) }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{KEYS_TEXT.resetAllTitle}</AlertDialogTitle>
              <AlertDialogDescription>{KEYS_TEXT.resetAllBody(custom)}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel autoFocus>{KEYS_TEXT.cancel}</AlertDialogCancel>
              <AlertDialogAction variant="destructive" onClick={() => { resetAllKeybindings(); setEdited(ALL) }}>{KEYS_TEXT.resetAll}</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </div>
  )
}
