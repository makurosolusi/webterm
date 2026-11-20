// "Initialize git repository" as one structured control: the whole row (box, title, one-line
// description) is the click target, at least 44px tall on touch screens.
import { Checkbox } from '@/components/ui/checkbox'
import { CREATE_TEXT } from './workspaceCreate.labels'

export function GitInitOption({ checked, disabled, onChange }: { checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }): React.JSX.Element {
  return (
    <label className="flex min-h-11 cursor-pointer items-start gap-2 rounded-(--vscode-cornerRadius-small) py-2 sm:min-h-0 sm:py-0" data-testid="git-init-option">
      <Checkbox id="new-project-git" className="mt-0.5" checked={checked} disabled={disabled} aria-labelledby="new-project-git-title" aria-describedby="new-project-git-desc" onCheckedChange={(c) => onChange(c === true)} />
      <span className="flex flex-col gap-1">
        <span id="new-project-git-title" className="font-medium">{CREATE_TEXT.git.label}</span>
        <span id="new-project-git-desc" className="text-(--vscode-descriptionForeground)">{CREATE_TEXT.git.description}</span>
      </span>
    </label>
  )
}
