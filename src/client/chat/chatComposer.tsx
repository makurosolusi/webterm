// Composer for the chat panel: Enter sends, Shift+Enter inserts a newline. While a turn is live
// the primary button becomes Stop (RND/11 §3): a second send would be a 409, so the UI offers the
// action that can actually make progress. A busy conversation from another tab still shows Stop
// because the panel learns `activeTurnId` from the 409 body.
import { useState } from 'react'
import type { KeyboardEvent } from 'react'
import { Send, Square } from 'lucide-react'

export interface ChatComposerProps {
  busy: boolean
  disabled?: boolean
  onSend: (text: string) => void
  onStop: () => void
}

const MAX_ROWS = 6

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
      <textarea
        className="chat-composer__input"
        aria-label="Message the central agent"
        placeholder={props.busy ? 'Turn running. Stop or wait…' : 'Message the central agent…'}
        rows={2}
        value={text}
        disabled={props.disabled}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        style={{ maxHeight: `${MAX_ROWS * 20}px` }}
      />
      {props.busy ? (
        <button type="button" className="chat-send chat-send--stop" onClick={props.onStop}
          aria-label="Stop turn" title="Stop turn">
          <Square size={14} /> Stop
        </button>
      ) : (
        <button type="button" className="chat-send" onClick={submit} disabled={!canSend}
          aria-label="Send message" title="Send (Enter)">
          <Send size={14} /> Send
        </button>
      )}
    </div>
  )
}
