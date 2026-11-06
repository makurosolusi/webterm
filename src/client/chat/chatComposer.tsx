// Composer for the chat panel: Enter sends, Shift+Enter inserts a newline, ArrowUp at the start
// recalls earlier messages (ArrowDown walks forward). The box grows with its content up to six
// lines. While a turn is live the primary button becomes Stop (RND/11 §3): a second send would
// be a 409, so the UI offers the action that can actually make progress. A busy conversation
// from another tab still shows Stop because the panel learns `activeTurnId` from the 409 body.
// With `attach` the composer also takes files (chatComposerAttach): an image-only message may be sent.
import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { IconButton, IconTooltip } from '@/components/ui/icon-button'
import type { KeyboardEvent, RefObject } from 'react'
import type { ComposerImage } from './chatAttach'
import { AttachTray, useComposerAttach, type AttachFiles } from './chatComposerAttach'

export interface ChatComposerProps {
  busy: boolean
  disabled?: boolean
  /** `images` is always [] without `attach`. */
  onSend: (text: string, images: ComposerImage[]) => void
  onStop: () => void
  /** Accessible name of the textarea (default: the central agent's). */
  label?: string
  placeholder?: string
  /** Chars a message may have; longer text cannot be sent and shows why. */
  maxLength?: number
  /** Opt-in attachments: paste, drop and the "+" picker resolve files through this. */
  attach?: AttachFiles
  /** Where files may be dropped (default: the composer itself). */
  dropZone?: RefObject<HTMLElement | null>
}

/** Lines the textarea may grow to before it scrolls. */
const MAX_LINES = 6

/** Next history slot: -1 steps back (older), +1 forward; `null` leaves the draft untouched. */
export function stepHistory(length: number, index: number | null, delta: -1 | 1): number | null {
  if (length === 0) return null
  if (delta === -1) return index === null ? length - 1 : Math.max(0, index - 1)
  if (index === null) return null
  return index + 1 >= length ? null : index + 1
}

export default function ChatComposer(props: ChatComposerProps) {
  const [text, setText] = useState('')
  const area = useRef<HTMLTextAreaElement | null>(null)
  const history = useRef<string[]>([])
  const slot = useRef<number | null>(null)
  const draft = useRef('')
  const root = useRef<HTMLDivElement | null>(null)
  const picker = useRef<HTMLInputElement | null>(null)
  const insert = useCallback((add: string) => setText((cur) => (cur && !/\s$/.test(cur) ? `${cur} ${add}` : `${cur}${add}`)), [])
  const files = useComposerAttach(props.attach, !!props.disabled, insert, props.dropZone ?? root)
  const tooLong = props.maxLength !== undefined && text.length > props.maxLength
  const hasContent = text.trim() !== '' || files.images.length > 0
  const canSend = hasContent && !props.busy && !props.disabled && !tooLong && !files.busy

  // Auto-grow: measure from `auto` so the box also shrinks after a send or a deletion.
  useLayoutEffect(() => {
    const el = area.current
    if (!el) return
    el.style.height = 'auto'
    const line = Number.parseFloat(getComputedStyle(el).lineHeight) || 18
    el.style.height = `${Math.min(el.scrollHeight, line * MAX_LINES)}px`
  }, [text])

  const submit = (): void => {
    if (!canSend) return
    const sent = text.trim()
    if (sent) history.current.push(sent)
    slot.current = null
    props.onSend(sent, files.take())
    setText('')
  }

  const recall = (delta: -1 | 1): boolean => {
    const next = stepHistory(history.current.length, slot.current, delta)
    if (next === null && (delta === -1 || slot.current === null)) return false
    if (slot.current === null) draft.current = text
    slot.current = next
    setText(next === null ? draft.current : history.current[next] ?? '')
    return true
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    // IME composition: Enter confirms a candidate, it must not send the message.
    if (event.nativeEvent.isComposing) return
    const el = event.currentTarget
    const modified = event.shiftKey || event.altKey || event.ctrlKey || event.metaKey
    if (event.key === 'ArrowUp' && !modified && el.selectionStart === 0 && el.selectionEnd === 0 && recall(-1)) {
      event.preventDefault()
      return
    }
    if (event.key === 'ArrowDown' && !modified && slot.current !== null
      && el.selectionStart === el.value.length && recall(1)) {
      event.preventDefault()
      return
    }
    if (event.key !== 'Enter' || event.shiftKey) return
    event.preventDefault()
    submit()
  }

  return (
    <div className="chat-composer" ref={root}>
      <AttachTray a={files} />
      <div className="chat-composer__box">
        {props.attach && (
          <>
            <IconButton label="Attach files" tooltip="Attach files or images (or paste / drop them)" size="icon-xs"
              className="chat-composer__attach" disabled={props.disabled} onClick={() => picker.current?.click()}>
              <span className="codicon codicon-add" aria-hidden="true" />
            </IconButton>
            <input ref={picker} type="file" multiple hidden tabIndex={-1} aria-hidden="true" data-testid="chat-attach-input"
              onChange={(e) => {
                const picked = Array.from(e.target.files ?? [])
                e.target.value = '' // picking the same file again still fires change
                void files.attach(picked)
              }} />
          </>
        )}
        <textarea
          ref={area}
          className="chat-composer__input"
          aria-label={props.label ?? 'Message the central agent'}
          placeholder={props.placeholder ?? (props.busy ? 'Turn running. Stop or wait…' : 'Ask the central agent…')}
          rows={1}
          value={text}
          disabled={props.disabled}
          onChange={(event) => { slot.current = null; setText(event.target.value) }}
          onKeyDown={onKeyDown}
          onPaste={files.onPaste}
        />
        {props.busy ? (
          <IconTooltip label="Stop the running turn">
            <button type="button" className="chat-composer__send" onClick={props.onStop} aria-label="Stop turn">
              <span className="codicon codicon-debug-stop" aria-hidden="true" />
            </button>
          </IconTooltip>
        ) : (
          <IconTooltip label="Send message" shortcut="Enter" disabled={!canSend}
            disabledReason={props.disabled ? 'chat is disabled' : tooLong ? 'message is too long' : files.busy ? 'attaching files' : 'type a message first'}>
            <button type="button" className="chat-composer__send" onClick={submit} disabled={!canSend} aria-label="Send message">
              <span className="codicon codicon-send" aria-hidden="true" />
            </button>
          </IconTooltip>
        )}
      </div>
      {tooLong && (
        <p className="chat-composer__limit" role="alert">
          {`Message is ${text.length.toLocaleString('en-US')} characters; the limit is ${props.maxLength?.toLocaleString('en-US')}. Shorten it to send.`}
        </p>
      )}
    </div>
  )
}
