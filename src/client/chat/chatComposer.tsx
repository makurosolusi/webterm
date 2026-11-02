// Composer for the chat panel: Enter sends, Shift+Enter inserts a newline. While a turn is live
// the primary button becomes Stop (RND/11 §3): a second send would be a 409, so the UI offers the
// action that can actually make progress. A busy conversation from another tab still shows Stop
// because the panel learns `activeTurnId` from the 409 body.
import { useState } from 'react'
import type { KeyboardEvent } from 'react'
import { Send, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'

export interface ChatComposerProps {
  busy: boolean
  disabled?: boolean
  onSend: (text: string) => void
  onStop: () => void
}

// Tinggi maksimum textarea: 6 baris × line-height 20px. Nilainya literal dan statis supaya
// Tailwind menemukan kelasnya saat scan; angka dan kelas ini harus tetap sepasang.
const INPUT_MAX_HEIGHT_CLASS = 'max-h-[120px]'

export default function ChatComposer(props: ChatComposerProps) {
  const [text, setText] = useState('')
  const canSend = text.trim() !== '' && !props.busy && !props.disabled

  const submit = (): void => {
    if (!canSend) return
    props.onSend(text.trim())
    setText('')
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Enter' || event.shiftKey) return
    // IME composition: Enter confirms a candidate, it must not send the message.
    if (event.nativeEvent.isComposing) return
    event.preventDefault()
    submit()
  }

  return (
    <div className="chat-composer">
      <Textarea
        className={`chat-composer__input ${INPUT_MAX_HEIGHT_CLASS}`}
        aria-label="Message the central agent"
        placeholder={props.busy ? 'Turn running. Stop or wait…' : 'Message the central agent…'}
        rows={2}
        value={text}
        disabled={props.disabled}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
      />
      {props.busy ? (
        <Button type="button" variant="destructive" size="sm" onClick={props.onStop}
          aria-label="Stop turn" title="Stop turn">
          <Square size={14} /> Stop
        </Button>
      ) : (
        <Button type="button" size="sm" onClick={submit} disabled={!canSend}
          aria-label="Send message" title="Send (Enter)">
          <Send size={14} /> Send
        </Button>
      )}
    </div>
  )
}
