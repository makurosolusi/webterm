// ⌘K omnibox / ⌘P Go to File / ⌘⇧F Find in Files: one quick-input, modes by prefix like VS Code
// Quick Open (`>` commands, `%` text search). Same markup and CSS as `VscodeQuickPick`; it is not
// reused because that pick ranks a fixed item list and renders every match, while this list is
// computed per query (typed URL, 50k-file workspaces capped per group, paged search results).
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { highlightSegments } from '@/components/vscode/vscodeQuickPickRanking'
import { portalContainer, useOnFullscreenChange } from '@/components/vscode/portalContainer'
import '@/components/vscode/vscode-quick-pick.css'
import { omniboxItems, omniMode, omniNeedle, searchItems, type OmniAction, type OmniItem, type OmniScope, type OmniSources } from './Omnibox.sources'
import { SEARCH_TEXT, useTextSearch, useWorkspaceFiles } from './Omnibox.data'
import { loadRecentFiles, recentUnder } from './QuickOpen.recency'

export const OMNIBOX_TEXT = {
  placeholder: { all: 'Go to node, file, URL, agent, or type > for commands, % to search text', files: 'Go to file (type % to search text, > for commands)' },
  empty: 'No results',
  hint: 'Enter to open · ↑↓ to move · Esc to close',
  noWorkspace: 'Open a workspace to search its files.',
}

export interface OmniboxProps {
  scope: OmniScope
  /** Text the box opens with (`%` for Find in Files). */
  initialQuery?: string
  /** Active workspace cwd; files and text search are scoped to it. */
  root?: string
  sources: Omit<OmniSources, 'files' | 'recentFiles'>
  onAction: (action: OmniAction) => void
  onClose: () => void
}

export default function Omnibox({ scope, initialQuery = '', root, sources, onAction, onClose }: OmniboxProps) {
  const [query, setQuery] = useState(initialQuery)
  const [active, setActive] = useState(0)
  const listId = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  useOnFullscreenChange(onClose)

  const mode = omniMode(query, scope)
  const needle = omniNeedle(query)
  const listed = useWorkspaceFiles(root, mode === 'files' || mode === 'mixed')
  const text = useTextSearch(root, needle, mode === 'search')
  const recentFiles = useMemo(() => (root ? recentUnder(root, loadRecentFiles()) : []), [root])

  const items: OmniItem[] = useMemo(
    () => (mode === 'search' ? searchItems(text.matches, text.hasMore) : omniboxItems(query, scope, { ...sources, files: listed.files, recentFiles })),
    [mode, text.matches, text.hasMore, query, scope, sources, listed.files, recentFiles],
  )
  const at = Math.min(active, Math.max(items.length - 1, 0))
  useEffect(() => { setActive(0) }, [query])
  useEffect(() => { inputRef.current?.focus() }, [])
  useEffect(() => { rootRef.current?.querySelector('[data-active="true"]')?.scrollIntoView?.({ block: 'nearest' }) }, [at, items])

  // Click outside closes, like the command palette.
  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (!rootRef.current?.contains(e.target as Node)) onClose() }
    // Capture phase: d3-zoom (React Flow pane) stopImmediatePropagation()s mousedown, so a bubble listener on document never sees a canvas click.
    document.addEventListener('mousedown', onDown, true)
    return () => document.removeEventListener('mousedown', onDown, true)
  }, [onClose])

  const choose = (item: OmniItem | undefined) => {
    if (!item) return
    if (item.action.kind === 'more') { text.loadMore(); return }
    onClose()
    onAction(item.action)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation() // keys here belong to the box, not the canvas (arrows pan, Backspace deletes nodes)
    const step = { ArrowDown: 1, ArrowUp: -1, PageDown: 10, PageUp: -10 }[e.key]
    if (step !== undefined) { e.preventDefault(); setActive(Math.min(Math.max(at + step, 0), Math.max(items.length - 1, 0))) }
    else if (e.key === 'Enter') { e.preventDefault(); choose(items[at]) }
    else if (e.key === 'Escape') { e.preventDefault(); onClose() }
  }

  const status = mode === 'search' ? (text.busy ? SEARCH_TEXT.searching : text.notice)
    : !root && mode !== 'commands' ? OMNIBOX_TEXT.noWorkspace
    : listed.error ? SEARCH_TEXT.noFiles + listed.error : undefined

  let lastGroup: string | undefined
  return createPortal(
    <div ref={rootRef} role="dialog" aria-label={OMNIBOX_TEXT.placeholder[scope]} data-slot="vscode-quick-pick" className="vscode-quick-pick">
      <input
        ref={inputRef} role="combobox" type="text" value={query} placeholder={OMNIBOX_TEXT.placeholder[scope]}
        aria-label={OMNIBOX_TEXT.placeholder[scope]} aria-expanded="true" aria-controls={listId} aria-autocomplete="list"
        aria-activedescendant={items[at] ? `${listId}-${at}` : undefined}
        className="vscode-quick-pick__input" onChange={(e) => setQuery(e.target.value)} onKeyDown={onKeyDown}
      />
      {status ? <div role="status" className="vscode-quick-pick__hint">{status}</div> : null}
      <div id={listId} role="listbox" aria-label={OMNIBOX_TEXT.placeholder[scope]} className="vscode-quick-pick__list">
        {items.length === 0 && !(mode === 'search' && (text.busy || !needle)) ? (
          <div role="presentation" className="vscode-quick-pick__empty">{OMNIBOX_TEXT.empty}</div>
        ) : null}
        {items.flatMap((item, i) => {
          const header = item.group !== lastGroup ? <div key={`g-${item.group}-${i}`} role="presentation" className="vscode-quick-pick__group">{item.group}</div> : null
          lastGroup = item.group
          const row = (
            <div
              key={item.id} id={`${listId}-${i}`} role="option" aria-selected={i === at} data-active={i === at ? 'true' : 'false'}
              className="vscode-quick-pick__item" onMouseEnter={() => setActive(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => choose(item)}
            >
              <span className="vscode-quick-pick__icon" aria-hidden="true"><span className={`codicon codicon-${item.icon}`} /></span>
              <span className="vscode-quick-pick__label">
                {highlightSegments(item.label, mode === 'search' ? '' : needle).map((s, k) => (s.match ? <span key={k} className="vscode-quick-pick__highlight">{s.text}</span> : s.text))}
              </span>
              {item.description ? <span className="vscode-quick-pick__description">{item.description}</span> : null}
              {item.keybinding ? <span className="vscode-quick-pick__keybinding">{item.keybinding}</span> : null}
            </div>
          )
          return header ? [header, row] : [row]
        })}
      </div>
      <div role="presentation" className="vscode-quick-pick__hint">{OMNIBOX_TEXT.hint}</div>
    </div>,
    portalContainer(),
  )
}
