// Settings › Keyboard Shortcuts: every registry command (commandRegistry.ts) with its live chord and
// where it comes from, like VS Code's Keyboard Shortcuts editor. Click a chord to record the next one
// (Escape cancels); a chord `rejectChord` refuses says why inline, and one already in use names the
// other command with a Replace action. Overrides go to keybindings.store (saved as `keybindings`), so
// the terminal hand-back (`isAppChord`) and Monaco (`editorChords`) follow them as before.
import { Fragment, useEffect, useMemo, useState } from 'react'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { chordKeys, chordLabel, commandCategory, eventChord, findConflicts, useCommands, type Command } from './commandRegistry'
import { conflictsFor, effectiveBindings, rejectChord, type BindingSource, type EffectiveBinding } from './keybindings.resolve'
import { resetAllKeybindings, resetKeybinding, setKeybinding, useKeybindingOverrides } from './keybindings.store'
import { keybindingFieldId } from './settings.link'
import { Field, FieldSaveStatus, matchesSearch, normalizeQuery } from './SettingsFields'
import { useFieldSave } from './settingsSave'
import { isMacPlatform } from './terminalKeys.platform'
import { settingsSaves } from './useSettings'
import './commandRegistry.defaults' // the fixed and surface shortcuts are listed even where App is not mounted
import './helpOverlay.css'
import './settings-keybindings.css'

export const KEYS_TEXT = {
  filter: 'Search shortcuts',
  source: { default: 'Default', setting: 'Default', user: 'Custom', builtin: 'Built-in' } satisfies Record<BindingSource, string>,
  unbound: 'Not bound',
  change: (label: string): string => `Change shortcut: ${label}`,
  recording: 'Press the new shortcut, Escape to cancel',
  inUse: (chord: string, others: string): string => `${chord} is already used by ${others}.`,
  replace: 'Replace',
  cancel: 'Cancel',
  alsoBound: (others: string): string => `Also bound to: ${others}`,
  none: (q: string): string => `No shortcuts match “${q}”.`,
  resetAll: 'Reset all',
  resetAllTitle: 'Reset all keyboard shortcuts?',
  resetAllBody: (n: number): string => `${n} custom ${n === 1 ? 'shortcut goes' : 'shortcuts go'} back to the default.`,
} as const

/** The settings key whose save state shows a shortcut change. */
const SAVE_KEY = 'keybindings'
const ALL = '*'

function Chord({ chord, isMac }: { chord: string; isMac: boolean }): React.JSX.Element {
  return (
    <span className="help-shortcuts__chord" data-slot="keybinding-chord">
      {chordKeys(chord, isMac).map((key, i) => (
        <Fragment key={`${key}-${i}`}>
          {i > 0 && !isMac ? <span className="help-shortcuts__plus">+</span> : null}
          <kbd className="help-kbd">{key}</kbd>
        </Fragment>
      ))}
    </span>
  )
}

interface Pending { id: string; chord: string; others: readonly Command[] }

export function KeybindingsSection(): React.JSX.Element {
  const isMac = isMacPlatform()
  const list = useCommands()
  const overrides = useKeybindingOverrides()
  const [query, setQuery] = useState('')
  const [recording, setRecording] = useState<string | null>(null)
  const [problem, setProblem] = useState<{ id: string; text: string } | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [edited, setEdited] = useState<string | null>(null)
  const [confirmAll, setConfirmAll] = useState(false)
  const save = useFieldSave(settingsSaves, SAVE_KEY)

  const rows = useMemo(() => {
    const byCategory = new Map<string, EffectiveBinding[]>()
    for (const b of effectiveBindings(list, overrides)) {
      const cat = commandCategory(b.cmd)
      byCategory.set(cat, [...(byCategory.get(cat) ?? []), b])
    }
    return [...byCategory.keys()].sort().flatMap((cat) => byCategory.get(cat)!)
  }, [list, overrides])
  const clashes = useMemo(() => findConflicts(list, overrides), [list, overrides])
  const labelOf = (id: string): string => list.find((c) => c.id === id)?.label ?? id
  const q = normalizeQuery(query)
  const shown = rows.filter((b) => matchesSearch(
    `${b.cmd.label} ${commandCategory(b.cmd)} ${b.key ? chordLabel(b.key, isMac) : ''} ${KEYS_TEXT.source[b.source]} ${b.cmd.id}`, q))
  const custom = Object.keys(overrides).length

  const commit = (id: string, chord: string | null): void => {
    setKeybinding(id, chord)
    setEdited(id)
  }

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
      const others = conflictsFor(chord, cmd.scope ?? 'global', list, overrides).filter((c) => c.id !== cmd.id)
      if (others.length) setPending({ id: cmd.id, chord, others })
      else commit(cmd.id, chord)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recording, list, overrides, isMac])

  const replace = (p: Pending): void => {
    // Built-in shortcuts belong to their surface and keep their key; every rebindable holder lets go of it.
    for (const o of p.others) if (!o.fixed) setKeybinding(o.id, null)
    commit(p.id, p.chord)
    setPending(null)
  }

  return (
    <div className="st-keybindings" data-slot="settings-keybindings">
      <div className="st-kb-toolbar">
        <input type="search" className="st-search st-kb-filter" aria-label={KEYS_TEXT.filter} placeholder={KEYS_TEXT.filter}
          value={query} onChange={(e) => setQuery(e.target.value)} />
        {custom ? <button type="button" className="st-button" onClick={() => setConfirmAll(true)}>{KEYS_TEXT.resetAll}</button> : null}
        {edited === ALL ? <FieldSaveStatus save={save} /> : null}
      </div>
      <div className="st-kb-head" aria-hidden="true"><span>Command</span><span>Shortcut</span><span>Source</span></div>
      {shown.length ? shown.map((b) => {
        const { cmd } = b
        const rec = recording === cmd.id
        const ask = pending?.id === cmd.id ? pending : null
        const clash = clashes.get(cmd.id)
        return (
          <Field key={cmd.id} label={cmd.label} hint={cmd.when} field={keybindingFieldId(cmd.id)} htmlFor={`st-kb-${cmd.id}`}
            modified={b.source === 'user'} onReset={() => { resetKeybinding(cmd.id); setEdited(cmd.id) }}
            save={edited === cmd.id ? save : undefined}>
            <div className="st-kb-row">
              {cmd.fixed ? (
                <span id={`st-kb-${cmd.id}`} className="st-kb-chord">
                  {b.key ? <Chord chord={b.key} isMac={isMac} /> : <span className="st-hint">{cmd.gesture ?? KEYS_TEXT.unbound}</span>}
                </span>
              ) : (
                <button id={`st-kb-${cmd.id}`} type="button" className="st-kb-chord st-kb-record" aria-label={KEYS_TEXT.change(cmd.label)}
                  aria-pressed={rec} data-settings-escape={rec ? '' : undefined}
                  onClick={() => { setPending(null); setProblem(null); setRecording(rec ? null : cmd.id) }}>
                  {rec ? <span role="status">{KEYS_TEXT.recording}</span>
                    : b.key ? <Chord chord={b.key} isMac={isMac} /> : <span className="st-hint">{KEYS_TEXT.unbound}</span>}
                </button>
              )}
              <span className="st-kb-source" data-source={b.source}>{KEYS_TEXT.source[b.source]}</span>
            </div>
            {problem?.id === cmd.id ? <p className="st-save st-save--error" role="alert">{problem.text}</p> : null}
            {ask ? (
              <div className="st-kb-conflict" role="alert">
                <span>{KEYS_TEXT.inUse(chordLabel(ask.chord, isMac), ask.others.map((o) => o.label).join(', '))}</span>
                <button type="button" className="st-button" onClick={() => replace(ask)}>{KEYS_TEXT.replace}</button>
                <button type="button" className="st-button" onClick={() => setPending(null)}>{KEYS_TEXT.cancel}</button>
              </div>
            ) : clash ? <p className="st-hint" role="note">{KEYS_TEXT.alsoBound(clash.map(labelOf).join(', '))}</p> : null}
          </Field>
        )
      }) : <p className="st-no-results" role="status">{KEYS_TEXT.none(query.trim())}</p>}
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
