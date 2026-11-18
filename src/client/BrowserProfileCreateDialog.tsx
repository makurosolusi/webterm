// "New profile" dialog: the name is the one required input; the color is picked for you (server: a random hue no
// other profile uses) and can be changed. A new profile is global: any board can use it. Server refusals (`profile_name_taken`, ...) show inline, under the field.
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { BROWSER_PROFILE_NAME_MAX, validateProfileName } from '../shared/browser.profile'
import type { BrowserProfile } from '../shared/browser.profile'
import ProfileColorPicker from './BrowserProfileColor'
import type { ProfileColorValue } from './BrowserProfileColor'
import { createBrowserProfile } from './browserProfileApi'
import { PROFILE_TEXT as T, profileErrorText } from './browserProfile.text'

export interface BrowserProfileCreateDialogProps {
  /** Confirm button text; the node menu says "Create and switch". */
  submitLabel?: string
  onCreated: (profile: BrowserProfile) => void
  onClose: () => void
}

/** Modal form that creates a profile and reports it through `onCreated`; closing never creates anything. */
export default function BrowserProfileCreateDialog({ submitLabel = T.create, onCreated, onClose }: BrowserProfileCreateDialogProps): React.JSX.Element {
  const [name, setName] = useState('')
  const [color, setColor] = useState<ProfileColorValue>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const check = validateProfileName(name)

  const submit = (): void => {
    if (!check.ok || busy) return
    setBusy(true)
    setError(null)
    createBrowserProfile({ name: check.name, ...color }).then(
      (p) => onCreated(p),
      (e: unknown) => { setError(profileErrorText(e)); setBusy(false) },
    )
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !busy) onClose() }}>
      <DialogContent showCloseButton={false}>
        <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); submit() }}>
          <DialogHeader>
            <DialogTitle>{T.createTitle}</DialogTitle>
            <DialogDescription>{T.createHint}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1">
            <Label htmlFor="bp-name">{T.nameLabel}</Label>
            <Input
              id="bp-name" autoFocus value={name} maxLength={BROWSER_PROFILE_NAME_MAX} placeholder={T.namePlaceholder}
              aria-invalid={error !== null} aria-describedby="bp-name-help" disabled={busy}
              onChange={(e) => { setName(e.target.value); setError(null) }}
            />
            <p id="bp-name-help" className="m-0 text-xs text-(--vscode-descriptionForeground)">{T.nameHelp}</p>
            {error && <p role="alert" className="m-0 text-xs text-(--vscode-errorForeground)">{error}</p>}
          </div>
          <fieldset className="m-0 flex flex-col gap-1 border-0 p-0">
            <legend className="text-sm font-medium">{T.colorLabel}</legend>
            {color.color === undefined && <p className="m-0 text-xs text-(--vscode-descriptionForeground)">{T.autoColor}</p>}
            <ProfileColorPicker value={color} onChange={setColor} />
          </fieldset>
          <DialogFooter>
            <Button type="button" variant="secondary" disabled={busy} onClick={onClose}>{T.cancel}</Button>
            <Button type="submit" disabled={!check.ok || busy} aria-busy={busy}>{busy ? T.creating : submitLabel}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
