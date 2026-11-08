// Sanitized Markdown body of an assistant message, with code-block headers, Copy buttons and syntax
// colors (chatHighlight.ts: built from text nodes after sanitizing, theme-aware CSS classes).
import { useEffect, useMemo, useRef } from 'react'
import { renderMarkdown } from '../markdown'
import { decorateCodeBlocks, handleCodeCopyClick } from './chatCodeBlocks'
import { highlightCodeBlocks } from './chatHighlight'
import { monacoTokenize } from './chatHighlight.monaco'
import { handleMarkdownLinkEvent, openWebLink } from '../markdownLinks'
import { lspFileOpener } from '../editorLsp.store'
import { useNodeActions } from '../nodeActions'
import './chatHighlight.css'

/** Renders `source` through the shared sanitizer, then decorates its code blocks. */
export default function ChatMarkdown(props: { source: string }): React.JSX.Element {
  const html = useMemo(() => renderMarkdown(props.source), [props.source])
  const ref = useRef<HTMLDivElement | null>(null)
  const { openBrowserAt } = useNodeActions()
  // A link click must not navigate webterm's tab away: web links open in a browser node, absolute
  // file paths in an editor; chat has no folder, so a relative path does nothing.
  const onLink = (e: React.MouseEvent) => handleMarkdownLinkEvent(e, '', {
    openUrl: (url) => openWebLink(openBrowserAt, url),
    openFile: (path, line, column) => lspFileOpener()?.(path, line ?? 0, column ?? 0)
  })
  // React resets innerHTML whenever `html` changes, so decorate again after each change.
  useEffect(() => {
    if (!ref.current) return
    decorateCodeBlocks(ref.current)
    highlightCodeBlocks(ref.current, monacoTokenize).catch((err: unknown) =>
      console.warn('chat code highlighting failed', err instanceof Error ? err.message : err))
  }, [html])
  return <div className="chat-markdown" ref={ref} onClick={(e) => { handleCodeCopyClick(e); onLink(e) }} onAuxClick={onLink}
    dangerouslySetInnerHTML={{ __html: html }} />
}
