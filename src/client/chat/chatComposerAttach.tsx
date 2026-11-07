// Attachments of the chat composer (opt-in through `ChatComposerProps.attach`), after nodeterm's
// ChatComposer: "+" opens a picker, a paste or a drop attaches files, an `attachNote` shows progress
// or the failure. Images wait as removable thumbnails until sent; other files come back as paths the
// composer inserts into the draft. The drop zone may be larger than the composer (the whole chat):
// native listeners with a depth counter, the overlay is a data attribute (as filesSlot.upload.drop).
import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type RefObject } from 'react'
import { IconButton } from '@/components/ui/icon-button'
import { clipboardImages, pasteHasText, pastedFiles, type ComposerImage } from './chatAttach'
import './chatAttach.css'

/** What the host made of attached files: images to send, text (paths) for the draft, failure reasons. */
export interface AttachResult { images: ComposerImage[]; text: string; failed: string[] }
export type AttachFiles = (files: File[]) => Promise<AttachResult>

/** Attribute set on the drop zone while files are dragged over it (CSS draws the overlay). */
export const DROP_ATTR = 'data-attach-drop'

const isFileDrag = (dt: DataTransfer | null): dt is DataTransfer => !!dt && Array.from(dt.types).includes('Files')
const label = (files: File[]): string => (files.length === 1 ? files[0]?.name || 'file' : `${files.length} files`)

export interface ComposerAttach {
  images: ComposerImage[]
  note: { text: string; failed?: boolean } | null
  busy: boolean
  attach: (files: File[]) => Promise<void>
  remove: (index: number) => void
  dismiss: () => void
  /** Hand the pending images over (for a send) and empty the list. */
  take: () => ComposerImage[]
  onPaste: (e: ClipboardEvent<HTMLTextAreaElement>) => void
}

export function useComposerAttach(
  resolve: AttachFiles | undefined, disabled: boolean, insert: (text: string) => void, zone: RefObject<HTMLElement | null>,
): ComposerAttach {
  const [images, setImages] = useState<ComposerImage[]>([])
  const [note, setNote] = useState<ComposerAttach['note']>(null)
  const [busy, setBusy] = useState(false)
  const pending = useRef(0)

  const attach = useCallback(async (files: File[]) => {
    if (!resolve || disabled || files.length === 0) return
    pending.current++
    setBusy(true)
    setNote({ text: `Attaching ${label(files)}…` })
    try {
      const r = await resolve(files)
      if (r.images.length) setImages((cur) => [...cur, ...r.images])
      if (r.text) insert(r.text)
      setNote(r.failed.length ? { text: `Could not attach: ${r.failed.join(' ')}`, failed: true } : null)
    } catch (err) {
      setNote({ text: `Could not attach ${label(files)}: ${err instanceof Error ? err.message : 'unknown error'}`, failed: true })
    } finally {
      if (--pending.current === 0) setBusy(false)
    }
  }, [resolve, disabled, insert])

  const live = useRef(attach)
  live.current = attach
  useEffect(() => {
    const el = zone.current
    if (!el || !resolve) return
    let depth = 0
    const clear = (): void => { depth = 0; el.removeAttribute(DROP_ATTR) }
    const enter = (e: DragEvent): void => { if (isFileDrag(e.dataTransfer) && !disabled) { depth++; el.setAttribute(DROP_ATTR, '') } }
    const leave = (e: DragEvent): void => { if (isFileDrag(e.dataTransfer) && --depth <= 0) clear() }
    const over = (e: DragEvent): void => {
      if (!isFileDrag(e.dataTransfer) || disabled) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    }
    const drop = (e: DragEvent): void => {
      clear()
      if (!isFileDrag(e.dataTransfer) || disabled) return
      // Stopped here so the canvas never sees a drop aimed at the chat.
      e.preventDefault()
      e.stopPropagation()
      void live.current(Array.from(e.dataTransfer.files))
    }
    const esc = (e: KeyboardEvent): void => { if (e.key === 'Escape') clear() }
    el.addEventListener('dragenter', enter)
    el.addEventListener('dragleave', leave)
    el.addEventListener('dragover', over)
    el.addEventListener('drop', drop)
    // A drag cancelled with Esc, dropped elsewhere or ended by an app switch never sends a dragleave.
    window.addEventListener('drop', clear)
    window.addEventListener('dragend', clear)
    window.addEventListener('blur', clear)
    document.addEventListener('keydown', esc)
    return () => {
      el.removeEventListener('dragenter', enter)
      el.removeEventListener('dragleave', leave)
      el.removeEventListener('dragover', over)
      el.removeEventListener('drop', drop)
      window.removeEventListener('drop', clear)
      window.removeEventListener('dragend', clear)
      window.removeEventListener('blur', clear)
      document.removeEventListener('keydown', esc)
      clear()
    }
  }, [zone, resolve, disabled])

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>): void => {
    if (!resolve) return
    const files = pastedFiles(e.clipboardData)
    if (files.length) {
      // The files are the paste: no file name or image bytes leak into the draft as text.
      e.preventDefault()
      void attach(files)
      return
    }
    if (pasteHasText(e.clipboardData)) return
    clipboardImages().then((found) => attach(found), (err: unknown) =>
      setNote({ text: `Could not read the clipboard: ${err instanceof Error ? err.message : 'unknown error'}`, failed: true }))
  }

  return {
    images, note, busy, attach, onPaste,
    remove: (i) => setImages((cur) => cur.filter((_, n) => n !== i)),
    dismiss: () => setNote(null),
    take: () => { const out = images; setImages([]); setNote(null); return out },
  }
}

/** Pending images as thumbnails with a remove button each, and the attach note. */
export function AttachTray({ a }: { a: ComposerAttach }) {
  if (a.images.length === 0 && !a.note) return null
  return (
    <div className="chat-attach">
      {a.images.length > 0 && (
        <ul className="chat-attach__list" aria-label="Attached images">
          {a.images.map((img, i) => (
            <li key={`${img.name}-${i}`} className="chat-attach__chip">
              {img.mediaType.startsWith('image/')
                ? <img className="chat-attach__thumb" src={`data:${img.mediaType};base64,${img.data}`} alt={img.name} />
                : <span className="codicon codicon-file" aria-hidden="true" />}
              <span className="chat-attach__name">{img.name}</span>
              <IconButton label={`Remove ${img.name}`} size="icon-xs" onClick={() => a.remove(i)}>
                <span className="codicon codicon-close" aria-hidden="true" />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
      {a.note && (
        <p className={`chat-attach__note${a.note.failed ? ' chat-attach__note--failed' : ''}`} role={a.note.failed ? 'alert' : 'status'}>
          {!a.note.failed && <span className="chat-progress" aria-hidden="true" />}
          <span>{a.note.text}</span>
          {a.note.failed && (
            <IconButton label="Dismiss attach error" size="icon-xs" onClick={a.dismiss}>
              <span className="codicon codicon-close" aria-hidden="true" />
            </IconButton>
          )}
        </p>
      )}
    </div>
  )
}
