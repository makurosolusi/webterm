// Step 1 of the import dialog: a drop target plus a "Choose file…" button. The real file input is visually hidden but
// stays in the DOM (label + accept) so assistive tech and tests can reach it; keyboard users use the button.
import { useRef, useState } from 'react'
import type { DragEvent, Ref } from 'react'
import { Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { COOKIE_FILE_EXTENSIONS } from './cookieImport.logic'
import { CI } from './cookieImport.text'

const ACCEPT = COOKIE_FILE_EXTENSIONS.join(',')
const HINT_ID = 'cookie-drop-hint'

export default function CookieDropZone({ disabled, fileName, onFile, chooseRef }: {
  disabled: boolean
  /** File being read; replaces the prompt with a status line. */
  fileName: string | null
  onFile: (file: File) => void
  /** Initial focus target of the dialog. */
  chooseRef?: Ref<HTMLButtonElement>
}): React.JSX.Element {
  const input = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  const stop = (e: DragEvent): void => { e.preventDefault(); e.stopPropagation() }
  const onDrop = (e: DragEvent): void => {
    stop(e); setOver(false)
    const file = e.dataTransfer.files[0]
    if (file && !disabled) onFile(file)
  }
  return (
    <div
      data-slot="cookie-drop" data-over={over || undefined}
      onDragOver={(e) => { stop(e); if (!disabled) setOver(true) }} onDragLeave={() => setOver(false)} onDrop={onDrop}
      className={cn(
        'flex flex-col items-center gap-1.5 rounded-(--bui-radius) border border-dashed border-(--vscode-input-border,var(--border)) px-4 py-5 text-center',
        over && 'border-(--vscode-focusBorder) bg-(--vscode-list-hoverBackground)', disabled && 'opacity-60',
      )}
    >
      <Upload aria-hidden="true" className="size-5 text-(--vscode-descriptionForeground)" />
      <p role="status" className="m-0 text-[length:var(--bui-font)]">{fileName ? CI.reading(fileName) : over ? CI.drop.dropping : CI.drop.prompt}</p>
      <div className="flex items-center gap-2 text-[length:var(--bui-font-sm)] text-(--vscode-descriptionForeground)">
        <span>{CI.drop.or}</span>
        <Button ref={chooseRef} type="button" size="bui" variant="secondary" disabled={disabled} aria-describedby={HINT_ID} onClick={() => input.current?.click()}>{CI.drop.choose}</Button>
      </div>
      <p id={HINT_ID} className="m-0 text-[length:var(--bui-font-sm)] text-(--vscode-descriptionForeground)">{CI.drop.hint}</p>
      <Input
        ref={input} type="file" accept={ACCEPT} disabled={disabled} tabIndex={-1} aria-label={CI.drop.label} aria-describedby={HINT_ID}
        data-testid="cookie-file-input" className="sr-only"
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onFile(f) }} // reset: the same file can be chosen again
      />
    </div>
  )
}
