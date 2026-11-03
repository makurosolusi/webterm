// Modal untuk dialog JavaScript halaman (alert/confirm/prompt/beforeunload). Semua teks dari halaman
// dirender sebagai TEKS; dialog tak dibiarkan menggantung — selalu dijawab lewat `onAnswer`.
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { BrowserDialog } from './browser.useSession'

const TITLE: Record<BrowserDialog['kind'], string> = {
  alert: 'This page says', confirm: 'This page asks', prompt: 'This page asks', beforeunload: 'Leave this page?',
}

export default function BrowserDialogView({ dialog, onAnswer }: {
  dialog: BrowserDialog
  onAnswer: (accept: boolean, text?: string) => void
}) {
  const [text, setText] = useState(dialog.defaultPrompt ?? '')
  const cancellable = dialog.kind !== 'alert'
  return (
    <div className="browser-dialog" role="alertdialog" aria-label={TITLE[dialog.kind]}>
      <p className="browser-dialog-title">{TITLE[dialog.kind]}</p>
      <p className="browser-dialog-message">{dialog.message}</p>
      {dialog.kind === 'prompt' && (
        <Input aria-label="Answer" value={text} autoFocus onChange={(e) => setText(e.target.value)} />
      )}
      <div className="browser-dialog-actions">
        {cancellable && <Button variant="secondary" onClick={() => onAnswer(false)}>Cancel</Button>}
        <Button onClick={() => onAnswer(true, dialog.kind === 'prompt' ? text : undefined)}>OK</Button>
      </div>
    </div>
  )
}
