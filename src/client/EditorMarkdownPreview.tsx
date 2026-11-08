// Rendered Markdown of an editor node (⌘M). Frontmatter shown apart (markdownFrontmatter.ts), body
// through the shared sanitizer (markdown.ts), code blocks decorated + highlighted like chat, relative
// images served by the fs `raw` verb, and every link click kept off webterm's own tab
// (markdownLinks.ts): web links → browser node, local links → editor node, `#x` → scroll here.
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { renderMarkdown, HEADING_ID_PREFIX } from './markdown'
import { frontmatterRows, splitFrontmatter } from './markdownFrontmatter'
import { handleMarkdownLinkEvent, openWebLink, resolvePath } from './markdownLinks'
import { decorateCodeBlocks, handleCodeCopyClick } from './chat/chatCodeBlocks'
import { highlightCodeBlocks } from './chat/chatHighlight'
import { monacoTokenize } from './chat/chatHighlight.monaco'
import { dirName } from './editorFile'
import { rawUrl } from './fsClient'
import { lspFileOpener } from './editorLsp.store'
import { useNodeActions } from './nodeActions'
import './chat/chatHighlight.css'

export interface EditorMarkdownPreviewProps {
  source: string
  filePath: string
  /** Owning editor node: anchors a new browser node beside it, keys the kept scroll position. */
  nodeId?: string
  /** Default: the app's editor opener (same one LSP "go to file" uses). */
  onOpenFile?: (path: string, line?: number, column?: number) => void
  /** Default: a browser node via `openBrowserAt`, else a new browser tab (noopener). */
  onOpenUrl?: (url: string) => void
}

// Scroll position per preview, so ⌘M to edit and back lands where the reader was.
// ponytail: never pruned; a number per node/file ever previewed in this tab.
const scrollTops = new Map<string, number>()

/** `html` with relative `<img src>` pointed at the file's folder through `rawUrl`. Done on an inert
 *  `<template>`, so the broken app-relative URL is never requested. */
export function rewriteImageSources(html: string, dir: string): string {
  const t = document.createElement('template')
  t.innerHTML = html
  for (const img of Array.from(t.content.querySelectorAll('img[src]'))) {
    const src = img.getAttribute('src')!.trim()
    if (!src || src.startsWith('//') || /^[a-z][a-z\d+.-]*:/i.test(src)) continue // absolute URL, data:
    const path = src.replace(/[?#].*$/, '')
    let rel = path
    try { rel = decodeURIComponent(path) } catch { /* keep as written */ }
    if (!rel.startsWith('/') && !dir) continue
    img.setAttribute('src', rawUrl(resolvePath(dir, rel)))
  }
  return t.innerHTML
}

export default function EditorMarkdownPreview(p: EditorMarkdownPreviewProps): React.JSX.Element {
  const { openBrowserAt } = useNodeActions()
  const dir = dirName(p.filePath)
  const { front, body } = useMemo(() => splitFrontmatter(p.source), [p.source])
  const rows = useMemo(() => (front === null ? null : frontmatterRows(front)), [front])
  const html = useMemo(() => rewriteImageSources(renderMarkdown(body), dir), [body, dir])
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const frontRef = useRef<HTMLDivElement | null>(null)
  const scrollKey = p.nodeId ?? p.filePath

  // React resets innerHTML whenever `html` changes, so decorate again after each change.
  useEffect(() => {
    if (!bodyRef.current) return
    decorateCodeBlocks(bodyRef.current)
    highlightCodeBlocks(bodyRef.current, monacoTokenize).catch((err: unknown) =>
      console.warn('preview code highlighting failed', err instanceof Error ? err.message : err))
  }, [html])
  useEffect(() => {
    if (!frontRef.current) return
    highlightCodeBlocks(frontRef.current, monacoTokenize).catch((err: unknown) =>
      console.warn('preview frontmatter highlighting failed', err instanceof Error ? err.message : err))
  }, [front, rows])
  useLayoutEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollTops.get(scrollKey) ?? 0
  }, [scrollKey])

  const openUrl = p.onOpenUrl ?? ((url: string) => openWebLink(openBrowserAt, url, p.nodeId))
  const openFile = p.onOpenFile ?? ((path: string, line?: number, column?: number) => lspFileOpener()?.(path, line ?? 0, column ?? 0))
  const onLink = (e: React.MouseEvent) => handleMarkdownLinkEvent(e, dir, {
    openUrl,
    openFile,
    scrollToAnchor: (id) => {
      const root = bodyRef.current
      const el = root?.querySelector(`[id="${CSS.escape(HEADING_ID_PREFIX + id)}"]`) ?? root?.querySelector(`[id="${CSS.escape(id)}"]`)
      el?.scrollIntoView?.({ block: 'start' })
    }
  })

  return (
    <div
      className="editor-node__md-body"
      ref={scrollRef}
      onScroll={(e) => scrollTops.set(scrollKey, e.currentTarget.scrollTop)}
      onClick={(e) => { handleCodeCopyClick(e); onLink(e) }}
      onAuxClick={onLink}
    >
      {front !== null && (
        <div className="editor-node__md-front" ref={frontRef} key={front}>
          {rows ? (
            <table>
              <tbody>
                {rows.map(([k, v], i) => (
                  <tr key={i}><th scope="row">{k}</th><td>{v}</td></tr>
                ))}
              </tbody>
            </table>
          ) : (
            <pre><code className="language-yaml">{front}</code></pre>
          )}
        </div>
      )}
      {/* Isi file adalah input tak terpercaya; `renderMarkdown` mensanitasi lewat DOMPurify dan
          fail-closed kalau sanitizer-nya tidak hidup. */}
      <div ref={bodyRef} dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  )
}
