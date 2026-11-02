// Sanitized Markdown body of an assistant message, with code-block headers and Copy buttons.
import { useEffect, useMemo, useRef } from 'react'
import { renderMarkdown } from '../markdown'
import { decorateCodeBlocks, handleCodeCopyClick } from './chatCodeBlocks'

/** Renders `source` through the shared sanitizer, then decorates its code blocks. */
export default function ChatMarkdown(props: { source: string }): React.JSX.Element {
  const html = useMemo(() => renderMarkdown(props.source), [props.source])
  const ref = useRef<HTMLDivElement | null>(null)
  // React resets innerHTML whenever `html` changes, so decorate again after each change.
  useEffect(() => {
    if (ref.current) decorateCodeBlocks(ref.current)
  }, [html])
  return <div className="chat-markdown" ref={ref} onClick={handleCodeCopyClick}
    dangerouslySetInnerHTML={{ __html: html }} />
}
