// "Parent folder" row shared by Clone repository and New project: editable path plus Browse, which
// the dialog answers by swapping itself for the existing FolderPicker (no modal-in-modal).
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export function ParentField({ id, value, disabled, onChange, onBrowse }: {
  id: string
  value: string
  disabled?: boolean
  onChange: (v: string) => void
  onBrowse: () => void
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>Parent folder</Label>
      <div className="flex gap-1">
        <Input id={id} value={value} placeholder="/path/to/projects" spellCheck={false} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
        <Button type="button" variant="outline" disabled={disabled} onClick={onBrowse}>Browse…</Button>
      </div>
    </div>
  )
}
