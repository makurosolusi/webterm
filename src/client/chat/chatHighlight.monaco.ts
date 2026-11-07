// Monaco-backed tokenizer for chat code blocks (chatHighlight.ts). Monaco is already a dependency (editor
// nodes) and is loaded once, lazily, through loadMonaco(): its chunk downloads on the first highlighted
// block. No extra highlighter package is shipped.
// API (monaco-editor 0.57 editor.api.d.ts): languages.getLanguages(), editor.tokenize(), editor.colorize().
import { loadMonaco } from '../lazyMonaco'
import type { CodeToken, Tokenize } from './chatHighlight'
import { tokenKind } from './chatHighlight'

let failed = false

/** Monaco language id for a Markdown fence name (`ts`, `bash`, `python`, ...): id, alias or file extension. */
function languageId(langs: Array<{ id: string; aliases?: string[]; extensions?: string[] }>, fence: string): string | undefined {
  const ext = `.${fence}`
  return (langs.find((l) => l.id === fence)
    ?? langs.find((l) => l.aliases?.some((a) => a.toLowerCase() === fence))
    ?? langs.find((l) => l.extensions?.includes(ext)))?.id
}

export const monacoTokenize: Tokenize = async (code, fence) => {
  // No Worker = no browser Monaco can run in (jsdom tests): plain blocks.
  if (failed || typeof Worker === 'undefined') return null
  try {
    const monaco = await loadMonaco()
    const id = languageId(monaco.languages.getLanguages(), fence)
    if (!id) return null
    // tokenize() does not wait for a lazily registered grammar; colorize() does, so it loads it first.
    await monaco.editor.colorize('', id, {})
    const lines = code.split(/\r\n|\r|\n/)
    return monaco.editor.tokenize(code, id).map((tokens, i): CodeToken[] => {
      const line = lines[i] ?? ''
      return tokens.map((t, j) => ({ text: line.slice(t.offset, tokens[j + 1]?.offset ?? line.length), ...(tokenKind(t.type) ? { kind: tokenKind(t.type) } : {}) }))
        .filter((t) => t.text)
    })
  } catch (err) {
    // Code stays readable as plain text; say once why it has no colors.
    failed = true
    console.warn('chat code highlighting is off: Monaco could not load', err instanceof Error ? err.message : err)
    return null
  }
}
