// "Parent folder" row shared by Clone repository and New project: editable path plus Browse, which
// the dialog answers by swapping itself for the existing FolderPicker (no modal-in-modal).
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { CREATE_TEXT } from './workspaceCreate.labels'

export function ParentField({ id, value, busy, onChange, onBrowse }: {
  id: string
  value: string
  /** The dialog is creating: the row is read-only until it answers. */
  busy?: boolean
  onChange: (v: string) => void
  onBrowse: () => void
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{CREATE_TEXT.parent.label}</Label>
      <div className="flex gap-2">
        <Input id={id} value={value} placeholder={CREATE_TEXT.parent.placeholder} spellCheck={false} disabled={busy} onChange={(e) => onChange(e.target.value)} />
        <Button type="button" variant="outline" disabled={busy} onClick={onBrowse}>{CREATE_TEXT.parent.browse}</Button>
      </div>
    </div>
  )
}
