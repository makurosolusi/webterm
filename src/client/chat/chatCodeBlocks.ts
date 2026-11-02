// Code-block chrome for rendered chat Markdown: a header with the language label and a Copy
// button above each `<pre><code>`, as in the VS Code Chat view. Works on the sanitized DOM
// after render (DOM APIs only, never innerHTML), so it adds no new HTML to trust.
import { writeClipboard } from '../clipboard'

/** Attribute that marks the Copy button inside a decorated block. */
export const COPY_ATTR = 'data-chat-copy'
const COPIED_RESET_MS = 1500

function languageOf(code: Element | null): string {
  const match = /(?:^|\s)language-([\w+#.-]+)/.exec(code?.className ?? '')
  return match?.[1] ?? 'text'
}

function icon(name: string): HTMLSpanElement {
  const span = document.createElement('span')
  span.className = `codicon codicon-${name}`
  span.setAttribute('aria-hidden', 'true')
  return span
}

/** Wrap every undecorated `pre` under `root` with a language header and a Copy button. */
export function decorateCodeBlocks(root: HTMLElement): void {
  for (const pre of Array.from(root.querySelectorAll('pre'))) {
    if (pre.parentElement?.classList.contains('chat-code')) continue
    const wrapper = document.createElement('div')
    wrapper.className = 'chat-code'
    const header = document.createElement('div')
    header.className = 'chat-code__header'
    const label = document.createElement('span')
    label.className = 'chat-code__lang'
    label.textContent = languageOf(pre.querySelector('code'))
    const copy = document.createElement('button')
    copy.type = 'button'
    copy.className = 'chat-code__copy'
    copy.setAttribute(COPY_ATTR, '')
    copy.setAttribute('aria-label', 'Copy code')
    copy.title = 'Copy'
    copy.append(icon('copy'))
    header.append(label, copy)
    pre.replaceWith(wrapper)
    wrapper.append(header, pre)
  }
}

/** Click handler for the Markdown container: copies the block behind a Copy button. */
export function handleCodeCopyClick(event: { target: EventTarget | null }): void {
  const button = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>(`[${COPY_ATTR}]`)
  const code = button?.closest('.chat-code')?.querySelector('pre')?.textContent
  if (!button || code === null || code === undefined) return
  void writeClipboard(code).then((ok) => {
    if (!ok) return
    button.replaceChildren(icon('check'))
    button.title = 'Copied'
    setTimeout(() => {
      button.replaceChildren(icon('copy'))
      button.title = 'Copy'
    }, COPIED_RESET_MS)
  })
}
