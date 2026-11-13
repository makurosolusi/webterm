// One line of Settings › Keyboard Shortcuts (SettingsKeybindings.tsx): Command | Keybinding | When |
// Source on the table's shared grid, like a VS Code Keyboard Shortcuts editor row. Rows are a roving
// tab stop (the table moves focus); the pencil and Reset are mouse affordances (tabIndex -1), every
// action is also on Enter / Delete / the context menu. `KeybindingDetail` is the full-width sub-row
// under a row for a refusal, a conflict to resolve, or the save state.
import { Fragment, type KeyboardEvent, type MouseEvent } from 'react'
import { Button } from '@/components/ui/button'
import { IconButton, IconTooltip } from '@/components/ui/icon-button'
import { chordKeys, type Command } from './commandRegistry'
import type { EffectiveBinding } from './keybindings.resolve'
import { keybindingFieldId } from './settings.link'
import { FieldSaveStatus } from './SettingsFields'
import type { FieldSave } from './settingsSave'
import { sourceLabel, whenOf } from './settingsKeybindings.model'

export const ROW_TEXT = {
  unbound: 'Not bound',
  change: (label: string): string => `Change keybinding: ${label}`,
  reset: (label: string): string => `Reset keybinding: ${label}`,
  recording: 'Press the new shortcut, Escape to cancel',
  fixed: 'Built into its node; can’t be changed',
  alsoBound: (others: string): string => `Also bound to: ${others}`,
  inUse: (chord: string, others: string): string => `${chord} is already used by ${others}.`,
  replace: 'Replace',
  cancel: 'Cancel',
} as const

export function Chord({ chord, isMac }: { chord: string; isMac: boolean }): React.JSX.Element {
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

export interface KeybindingRowProps {
  b: EffectiveBinding
  isMac: boolean
  focusable: boolean
  recording: boolean
  /** Labels of the other commands on the same chord and scope. */
  clash: readonly string[] | undefined
  onFocus: () => void
  onRecord: () => void
  onReset: () => void
  onMenu: (e: MouseEvent<HTMLDivElement>) => void
}

export function KeybindingRow({ b, isMac, focusable, recording, clash, onFocus, onRecord, onReset, onMenu }: KeybindingRowProps): React.JSX.Element {
  const { cmd } = b
  const source = sourceLabel(b)
  return (
    <div role="row" className="st-kb-grid st-kb-row" data-field={keybindingFieldId(cmd.id)} data-command={cmd.id}
      data-source={b.source} data-recording={recording ? '' : undefined} data-settings-escape={recording ? '' : undefined}
      tabIndex={focusable ? 0 : -1} onFocus={onFocus} onContextMenu={onMenu}
      onDoubleClick={() => { if (!cmd.fixed) onRecord() }}>
      <div role="cell" className="st-kb-cell st-kb-command"><span className="st-kb-label" title={cmd.label}>{cmd.label}</span></div>
      <div role="cell" className="st-kb-cell st-kb-key" aria-label={!recording && !b.key && !cmd.gesture ? ROW_TEXT.unbound : undefined}>
        {cmd.fixed ? null : (
          <IconButton size="icon-xs" className="st-kb-edit" tabIndex={-1} label={ROW_TEXT.change(cmd.label)} tooltip={ROW_TEXT.change(cmd.label)}
            aria-pressed={recording} onClick={onRecord}>
            <span className="codicon codicon-edit" aria-hidden />
          </IconButton>
        )}
        {recording ? <span className="st-kb-recording" role="status">{ROW_TEXT.recording}</span>
          : b.key ? <Chord chord={b.key} isMac={isMac} />
          : cmd.gesture ? <span className="st-kb-gesture">{cmd.gesture}</span> : null}
        {clash && !recording ? (
          <IconTooltip label={ROW_TEXT.alsoBound(clash.join(', '))}>
            <span role="img" tabIndex={-1} className="codicon codicon-warning st-kb-warn" aria-label={ROW_TEXT.alsoBound(clash.join(', '))} />
          </IconTooltip>
        ) : null}
      </div>
      <div role="cell" className="st-kb-cell st-kb-when">{whenOf(cmd)}</div>
      <div role="cell" className="st-kb-cell st-kb-source" data-source={source}>
        <span>{source}</span>
        {cmd.fixed ? (
          <IconTooltip label={ROW_TEXT.fixed}>
            <span role="img" tabIndex={-1} className="codicon codicon-lock st-kb-lock" aria-label={ROW_TEXT.fixed} />
          </IconTooltip>
        ) : source === 'User' ? (
          <IconButton size="icon-xs" tabIndex={-1} label={ROW_TEXT.reset(cmd.label)} onClick={onReset}>
            <span className="codicon codicon-discard" aria-hidden />
          </IconButton>
        ) : null}
      </div>
    </div>
  )
}

export interface DetailProps {
  cmd: Command
  problem: string | null
  /** A chord already in use: its label and the commands holding it. */
  ask: { chord: string; others: readonly Command[] } | null
  save: FieldSave | undefined
  onReplace: () => void
  onCancel: () => void
}

/** Full-width sub-row under a row; null when there is nothing to say. */
export function KeybindingDetail({ cmd, problem, ask, save, onReplace, onCancel }: DetailProps): React.JSX.Element | null {
  if (!problem && !ask && !save) return null
  const stop = (e: KeyboardEvent): void => e.stopPropagation() // arrows/Enter here act on the buttons, not the table
  return (
    <div role="row" className="st-kb-detail" data-detail-for={cmd.id} onKeyDown={stop}>
      <div role="cell" aria-colspan={4} className="st-kb-detail__cell">
        {problem ? <p className="st-save st-save--error" role="alert">{problem}</p> : null}
        {ask ? (
          <div className="st-kb-conflict" role="alert">
            <span>{ROW_TEXT.inUse(ask.chord, ask.others.map((o) => o.label).join(', '))}</span>
            <Button variant="outline" size="xs" onClick={onReplace}>{ROW_TEXT.replace}</Button>
            <Button variant="outline" size="xs" onClick={onCancel}>{ROW_TEXT.cancel}</Button>
          </div>
        ) : null}
        {save ? <FieldSaveStatus save={save} /> : null}
      </div>
    </div>
  )
}
