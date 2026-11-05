// Settings card "Default projects folder": where Clone repository / New project start. Shows the
// folder in use, lets the user type or Browse another, and Reset to `~/webterm/projects`. A new
// value is checked by the server first (absolute, not in the data dir, not a file); a missing
// folder is fine, it is made on first clone or new project.
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import FolderPicker from '../FolderPicker'
import { Field } from '../SettingsFields'
import { checkProjectsFolder, fetchDefaults } from './workspaceCreate.api'

const INPUT_ID = 'st-defaultProjectsFolder'
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export function ProjectsFolderSetting({ value, onChange }: { value: string; onChange: (v: string) => void }): React.JSX.Element | null {
  const [builtin, setBuiltin] = useState('')
  const [draft, setDraft] = useState(value)
  const [error, setError] = useState('')
  const [browsing, setBrowsing] = useState(false)
  useEffect(() => { void fetchDefaults().then((d) => setBuiltin(d.builtin), (e) => setError(errText(e))) }, [])
  // Saved value changed (Reset, undo): the field follows instead of keeping a stale draft.
  useEffect(() => setDraft(value), [value])

  const save = async (p: string): Promise<void> => {
    const v = p.trim()
    setDraft(v)
    if (!v) { setError(''); onChange(''); return }
    try {
      await checkProjectsFolder(v)
      setError('')
      onChange(v)
    } catch (e) {
      setError(errText(e))
    }
  }

  const current = value || builtin
  return (
    <Field label="Default projects folder" htmlFor={INPUT_ID} setting="defaultProjectsFolder"
      hint="Where Clone repository and New project put new folders. Created on first use.">
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <p className="m-0 text-xs opacity-80 [overflow-wrap:anywhere]" role="status">
          In use: <code>{current}</code>{value ? null : ' (default)'}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Input id={INPUT_ID} className="st-input st-mono min-w-48 flex-1" value={draft} placeholder={builtin} spellCheck={false}
            onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void save(draft) }} />
          <Button size="sm" variant="secondary" disabled={draft.trim() === value} onClick={() => void save(draft)}>Save</Button>
          <Button size="sm" variant="outline" onClick={() => setBrowsing(true)}>Browse…</Button>
          <Button size="sm" variant="ghost" disabled={!value} onClick={() => void save('')}>Reset to default</Button>
        </div>
        {error && <p className="m-0 text-xs text-destructive" role="alert">{error}</p>}
      </div>
      {browsing && (
        // The default may not exist yet, so the picker starts at the saved folder or the server's home.
        <FolderPicker initialPath={value || undefined} onClose={() => setBrowsing(false)}
          onPick={(p) => { setBrowsing(false); void save(p) }} />
      )}
    </Field>
  )
}
