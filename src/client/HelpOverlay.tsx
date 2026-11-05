// Keyboard Shortcuts, generated from the command registry (`commandRegistry.ts`), so the list
// cannot drift from what is wired. Imitates VS Code's Keyboard Shortcuts editor: Command /
// Keybinding table with `kbd` chips, "Change Keybinding" records the next chord (Escape cancels),
// overrides land in `keybindings.store.ts`, and a chord shared within one scope is flagged.
import { Fragment, useEffect, useMemo, useState } from 'react'
import { IconButton } from '@/components/ui/icon-button'
import { VscodeDialog } from '@/components/vscode/vscodeDialog'
import { detectDialogPlatform } from '@/components/vscode/vscodeDialogButtons'
import { chordKeys, effectiveKey, eventChord, findConflicts, useCommands, type Command } from './commandRegistry'
import { resetKeybinding, setKeybinding, useKeybindingOverrides } from './keybindings.store'
import './commandRegistry.defaults' // registers the fixed (surface-owned) shortcuts
import './helpOverlay.css'

export const HELP_TEXT = {
  title: 'Keyboard Shortcuts',
  change: 'Change keybinding',
  reset: 'Reset',
  resetHint: 'Reset to default keybinding',
  remove: 'Remove keybinding',
  recording: 'Press the new key combination, Escape to cancel',
  conflict: 'Also bound to: ',
  none: '—',
}

function Keybinding({ chord, isMac }: { chord: string; isMac: boolean }) {
  return (
    <span className="help-shortcuts__chord" data-slot="help-chord">
      {chordKeys(chord, isMac).map((key, index) => (
        <Fragment key={`${key}-${index}`}>
          {index > 0 && !isMac ? <span className="help-shortcuts__plus">+</span> : null}
          <kbd className="help-kbd">{key}</kbd>
        </Fragment>
      ))}
    </span>
  )
}

/** Records one chord while mounted; capture phase on window so nothing else acts on that key. */
function useChordRecorder(target: string | null, isMac: boolean, done: () => void): void {
  useEffect(() => {
    if (!target) return
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') { done(); return }
      const chord = eventChord(e, isMac)
      if (!chord) return // bare modifier: keep listening
      setKeybinding(target, chord)
      done()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [target, isMac, done])
}

export default function HelpOverlay({ onClose, platform, commands }: { onClose: () => void; platform?: string; commands?: readonly Command[] }) {
  const isMac = detectDialogPlatform(platform) === 'mac'
  const live = useCommands()
  const list = commands ?? live
  const overrides = useKeybindingOverrides()
  const conflicts = useMemo(() => findConflicts(list, overrides), [list, overrides])
  const labelOf = useMemo(() => new Map(list.map((c) => [c.id, c.label])), [list])
  const [recording, setRecording] = useState<string | null>(null)
  const stopRecording = useMemo(() => () => setRecording(null), [])
  useChordRecorder(recording, isMac, stopRecording)

  // Escape closes; while recording, the recorder above swallows it first (capture phase).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <VscodeDialog open onOpenChange={(open) => { if (!open && !recording) onClose() }} title={HELP_TEXT.title} width={760} className="help-overlay">
      <table className="help-shortcuts" data-slot="help-shortcuts">
        <thead>
          <tr>
            <th scope="col">Command</th>
            <th scope="col">Keybinding</th>
          </tr>
        </thead>
        <tbody>
          {list.map((cmd) => {
            const key = effectiveKey(cmd, overrides)
            const clash = conflicts.get(cmd.id)
            const editable = !cmd.fixed && !!cmd.run
            return (
              <tr key={cmd.id} data-command={cmd.id}>
                <td>
                  {cmd.label}
                  {clash ? (
                    <div className="help-shortcuts__conflict" data-slot="help-conflict" role="note">
                      {HELP_TEXT.conflict + clash.map((id) => labelOf.get(id) ?? id).join(', ')}
                    </div>
                  ) : null}
                </td>
                <td>
                  {recording === cmd.id ? (
                    <span className="help-shortcuts__gesture" role="status">{HELP_TEXT.recording}</span>
                  ) : key ? <Keybinding chord={key} isMac={isMac} />
                    : cmd.gesture ? <span className="help-shortcuts__gesture">{cmd.gesture}</span>
                    : <span className="help-shortcuts__gesture">{HELP_TEXT.none}</span>}
                  {editable && recording !== cmd.id ? (
                    <span className="help-shortcuts__actions">
                      <IconButton size="sm" label={`${HELP_TEXT.change}: ${cmd.label}`} tooltip={HELP_TEXT.change} onClick={() => setRecording(cmd.id)}>
                        <span className="codicon codicon-edit" aria-hidden />
                      </IconButton>
                      {key ? (
                        <IconButton size="sm" label={`${HELP_TEXT.remove}: ${cmd.label}`} tooltip={HELP_TEXT.remove} onClick={() => setKeybinding(cmd.id, null)}>
                          <span className="codicon codicon-close" aria-hidden />
                        </IconButton>
                      ) : null}
                      {Object.hasOwn(overrides, cmd.id) ? (
                        <IconButton size="sm" label={`${HELP_TEXT.reset}: ${cmd.label}`} tooltip={HELP_TEXT.resetHint} onClick={() => resetKeybinding(cmd.id)}>
                          <span className="codicon codicon-discard" aria-hidden />
                        </IconButton>
                      ) : null}
                    </span>
                  ) : null}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </VscodeDialog>
  )
}
