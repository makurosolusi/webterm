// Settings row "Default projects folder": where Clone repository / New project start. Settings
// without typing: Browse… picks a folder, and the box is the shared combobox (default + the folders
// used before, each removable), committing on pick / Enter / blur like every other combobox row. A new
// value is checked by the server first (absolute, not in the data dir, not a file) while the row
// says "Checking folder…"; then the field's own save status says Saving… / Saved, and its own Reset
// goes back to `~/webterm/projects`. A missing folder is fine, it is made on first clone or new project.
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import FolderPicker from '../FolderPicker'
import { rememberInput } from '../inputHistory.store'
import { SettingsCombobox } from '../SettingsCombobox'
import { Field } from '../SettingsFields'
import { checkProjectsFolder, fetchDefaults } from './workspaceCreate.api'

const INPUT_ID = 'st-defaultProjectsFolder'
/** Recent-folders key (`Settings.inputHistory`). */
export const PROJECTS_FOLDER_HISTORY = 'canvas.defaultProjectsFolder'
export const PROJECTS_FOLDER_TEXT = {
  label: 'Default projects folder',
  hint: 'Where Clone repository and New project put new folders. Created on first use.',
  browse: 'Browse…',
  checking: 'Checking folder…',
  defaultLabel: (builtin: string): string => `${builtin} (default)`,
  notAbsolute: 'Use an absolute path, e.g. /Users/you/code.',
} as const
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))
// Only the shape is checked here, so a typo is never remembered; the server checks the rest.
// ponytail: a path the server then rejects (inside the data folder) can still land in Recent; it is removable there.
const absolute = (v: string): string | null => (v === '' || /^(\/|[A-Za-z]:[\\/])/.test(v) ? null : PROJECTS_FOLDER_TEXT.notAbsolute)

export function ProjectsFolderSetting({ value, onChange }: { value: string; onChange: (v: string) => void }): React.JSX.Element | null {
  const [builtin, setBuiltin] = useState('')
  const [error, setError] = useState('')
  const [checking, setChecking] = useState(false)
  const [browsing, setBrowsing] = useState(false)
  useEffect(() => { void fetchDefaults().then((d) => setBuiltin(d.builtin), (e) => setError(errText(e))) }, [])

  const save = async (v: string): Promise<void> => {
    setError('')
    if (!v) { onChange(''); return }
    setChecking(true)
    try {
      await checkProjectsFolder(v)
      onChange(v)
      void rememberInput(PROJECTS_FOLDER_HISTORY, v) // a Browse pick joins Recent too (a typed one already did)
    } catch (e) {
      setError(errText(e))
    } finally {
      setChecking(false)
    }
  }

  return (
    <Field label={PROJECTS_FOLDER_TEXT.label} htmlFor={INPUT_ID} setting="defaultProjectsFolder" hint={PROJECTS_FOLDER_TEXT.hint}>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex min-w-0 items-start gap-2">
          <SettingsCombobox id={INPUT_ID} ariaLabel={PROJECTS_FOLDER_TEXT.label} fieldId={PROJECTS_FOLDER_HISTORY} mono
            value={value} placeholder={builtin} validate={absolute} error={error || undefined} disabled={checking}
            presets={builtin ? [{ value: '', label: PROJECTS_FOLDER_TEXT.defaultLabel(builtin) }] : []}
            onCommit={(v) => void save(v)} />
          <Button size="sm" variant="outline" disabled={checking} onClick={() => setBrowsing(true)}>{PROJECTS_FOLDER_TEXT.browse}</Button>
        </div>
        {checking ? <p className="m-0 text-xs opacity-80" role="status">{PROJECTS_FOLDER_TEXT.checking}</p> : null}
      </div>
      {browsing && (
        // The default may not exist yet, so the picker starts at the saved folder or the server's home.
        <FolderPicker initialPath={value || undefined} onClose={() => setBrowsing(false)}
          onPick={(p) => { setBrowsing(false); void save(p) }} />
      )}
    </Field>
  )
}
