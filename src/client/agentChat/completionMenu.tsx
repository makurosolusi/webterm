// The composer's `/` and `@` menu: a listbox above the textarea plus the hook that drives it. The
// trigger is DERIVED from the draft and the caret snapshot taken with that exact draft, so any change
// that did not come through the textarea (send, attach) closes the menu instead of completing a text
// it never saw. Keys while open: ↑/↓ move, Enter/Tab accept, Escape closes. Ported from nodeterm's
// ChatComposer; the pure rules live in composerCompletion.ts.
import { useEffect, useId, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import {
  applyCompletion, completionTriggerAt,
  type CompletionItem, type CompletionKind, type ComposerCompletion, type CompletionTrigger,
} from './composerCompletion'
import './completionMenu.css'

/** Every UI string of the menu (English). */
export const MENU_TEXT = {
  label: { slash: 'Commands and skills', file: 'Files and folders' },
  empty: { slash: 'No matching commands', file: 'No matching files' },
  loading: { slash: 'Loading commands…', file: 'Searching files…' },
  failed: 'Could not load suggestions: ',
}

export type MenuState =
  | { status: 'loading' }
  | { status: 'ready'; items: CompletionItem[] }
  | { status: 'error'; error: string }

interface MenuProps {
  id: string
  kind: CompletionKind
  state: MenuState
  active: number
  onHover: (i: number) => void
  onPick: (item: CompletionItem) => void
}

/** The listbox. Plain text nodes only: names and descriptions come from repository files. */
export function CompletionMenu({ id, kind, state, active, onHover, onPick }: MenuProps) {
  const items = state.status === 'ready' ? state.items : []
  useEffect(() => {
    document.getElementById(`${id}-${active}`)?.scrollIntoView?.({ block: 'nearest' })
  }, [id, active, items])
  const sigil = kind === 'slash' ? '/' : '@'
  return (
    // Mouse down keeps the textarea's focus: its blur would close the menu before the click lands.
    <div className="cmp-menu" onMouseDown={(e) => e.preventDefault()}>
      <div id={id} role="listbox" aria-label={MENU_TEXT.label[kind]} aria-busy={state.status === 'loading'}>
        {items.map((item, i) => (
          <div key={item.value} id={`${id}-${i}`} role="option" aria-selected={i === active}
            className={`cmp-item${i === active ? ' is-active' : ''}`}
            onMouseEnter={() => onHover(i)} onClick={() => onPick(item)}>
            <span className={`codicon codicon-${kind === 'slash' ? 'symbol-event' : item.dir ? 'folder' : 'file'} cmp-icon`} aria-hidden="true" />
            <span className="cmp-name">{sigil}{item.value}{item.dir ? '/' : ''}</span>
            {item.argumentHint && <span className="cmp-hint">{item.argumentHint}</span>}
            {item.description && <span className="cmp-desc" title={item.description}>{item.description}</span>}
            {item.badge && <span className={`cmp-badge cmp-badge--${item.badge.replace(/\W+/g, '-').toLowerCase()}`}>{item.badge}</span>}
          </div>
        ))}
      </div>
      {state.status === 'loading' && <div className="cmp-status" role="status">{MENU_TEXT.loading[kind]}</div>}
      {state.status === 'ready' && !items.length && <div className="cmp-status" role="status">{MENU_TEXT.empty[kind]}</div>}
      {state.status === 'error' && <div className="cmp-status cmp-status--error" role="alert">{MENU_TEXT.failed}{state.error}</div>}
    </div>
  )
}

type Snap = { value: string; start: number; end: number }

/**
 * Wires `completion` into a textarea whose draft is `text`. `onKeyDown` returns true when the menu
 * consumed the key (the composer must not act on it). Without `completion` everything is inert.
 */
export function useComposerCompletion(
  completion: ComposerCompletion | undefined,
  text: string,
  setText: (t: string) => void,
  area: RefObject<HTMLTextAreaElement | null>,
) {
  const id = useId()
  const [snap, setSnap] = useState<Snap | null>(null)
  const [dismissedAt, setDismissedAt] = useState<number | null>(null)
  const [state, setState] = useState<MenuState>({ status: 'loading' })
  const [active, setActive] = useState(0)
  const pendingCaret = useRef<number | null>(null)
  const stateToken = useRef<string | null>(null)
  const trigger: CompletionTrigger | null =
    completion && snap && snap.value === text ? completionTriggerAt(text, snap.start, snap.end) : null
  const open = !!trigger && dismissedAt !== trigger.start
  const key = open ? `${trigger.kind}:${trigger.start}:${trigger.query}` : null
  const tokenKey = open ? `${trigger.kind}:${trigger.start}` : null

  // A new token starts at the top of its list; typing within the same token keeps the place.
  useEffect(() => { setActive(0) }, [tokenKey])

  useEffect(() => {
    if (!key || !completion || !trigger) return
    let alive = true
    const same = stateToken.current === tokenKey
    stateToken.current = tokenKey
    try {
      const got = completion.provider(trigger)
      if (Array.isArray(got)) setState({ status: 'ready', items: got })
      else {
        // Keep the same token's previous list while the next query loads, so typing does not flicker.
        setState((s) => (same && s.status === 'ready' && s.items.length ? s : { status: 'loading' }))
        got.then(
          (items) => { if (alive) setState({ status: 'ready', items }) },
          (e: unknown) => { if (alive) setState({ status: 'error', error: e instanceof Error ? e.message : String(e) }) },
        )
      }
    } catch (e) {
      setState({ status: 'error', error: e instanceof Error ? e.message : String(e) })
    }
    return () => { alive = false }
    // `trigger` is fully described by `key`, so it is not a dependency.
  }, [key, completion])

  // After an accept, put the caret right after the inserted token once React committed the text.
  useEffect(() => {
    const el = area.current
    if (pendingCaret.current === null || !el || el.value !== text) return
    el.focus()
    el.setSelectionRange(pendingCaret.current, pendingCaret.current)
    pendingCaret.current = null
  }, [text, area])

  const items = state.status === 'ready' ? state.items : []
  const at = Math.min(active, Math.max(0, items.length - 1))

  const sync = (el: HTMLTextAreaElement): void => {
    if (!completion) return
    const t = completionTriggerAt(el.value, el.selectionStart, el.selectionEnd)
    // A new token (or none) forgets an Escape on the previous one.
    if (dismissedAt !== null && t?.start !== dismissedAt) setDismissedAt(null)
    setSnap({ value: el.value, start: el.selectionStart, end: el.selectionEnd })
  }

  const accept = (item: CompletionItem): void => {
    if (!trigger) return
    const next = applyCompletion(text, trigger, item)
    pendingCaret.current = next.caret
    setText(next.text)
    // A folder keeps the menu open on the new token; anything else closes it.
    setSnap(item.dir ? { value: next.text, start: next.caret, end: next.caret } : null)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open || !trigger || e.nativeEvent.isComposing) return false
    if (e.key === 'Escape') {
      setDismissedAt(trigger.start)
      return true
    }
    if (!items.length) return false
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      setActive((at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length)
      return true
    }
    // Enter accepts only when that CHANGES the draft: a fully typed `/compact` is a message, and a
    // bare `@` is not a choice ("hello @" + Enter sends). Tab always accepts.
    const typedExactly = text.slice(trigger.start, trigger.end) === (trigger.kind === 'slash' ? '/' : '@') + items[at].value
    const bareAt = trigger.kind === 'file' && !trigger.query
    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !typedExactly && !bareAt)) {
      accept(items[at])
      return true
    }
    return false
  }

  return {
    open,
    onKeyDown,
    sync,
    close: () => setSnap(null),
    /** Combobox attributes for the textarea; empty without `completion` (the Central chat stays as it was). */
    inputProps: completion
      ? {
          role: 'combobox' as const,
          'aria-autocomplete': 'list' as const,
          'aria-expanded': open,
          'aria-controls': open ? id : undefined,
          'aria-activedescendant': open && items.length ? `${id}-${at}` : undefined,
        }
      : {},
    menu: open && trigger
      ? <CompletionMenu id={id} kind={trigger.kind} state={state} active={at} onHover={setActive} onPick={accept} />
      : null,
  }
}
