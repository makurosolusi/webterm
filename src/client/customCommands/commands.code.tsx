// Renders text whose `backtick` spans are commands: they become <code>, the backticks are not shown.
import { Fragment } from 'react'

/** Inline text with each `span` drawn as monospace <code>. */
export function CodeText({ text }: { text: string }): React.JSX.Element {
  return <>{text.split('`').map((part, i) => (i % 2 ? <code key={i} className="rounded-sm bg-(--vscode-textCodeBlock-background,transparent) px-1 font-mono">{part}</code> : <Fragment key={i}>{part}</Fragment>))}</>
}
