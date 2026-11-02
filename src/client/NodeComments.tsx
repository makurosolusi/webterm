import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { Comment } from '../shared/workspace'
import { ToolbarButton } from '@/vscode/register'

export interface NodeCommentsProps {
  comments: Comment[]
  onAdd: (text: string) => void
  onClose: () => void
}

/** Widget komentar per-node bergaya comment widget VS Code: header, daftar, lalu input + "Add Comment". */
export default function NodeComments({ comments, onAdd, onClose }: NodeCommentsProps) {
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // Widget dibuka dari tombol toolbar; fokus langsung ke input supaya bisa mengetik tanpa klik lagi.
  useEffect(() => { inputRef.current?.focus() }, [])

  const send = () => {
    const text = draft.trim()
    if (!text) return
    onAdd(text)
    setDraft('')
  }

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'Enter' && !e.shiftKey && e.target === inputRef.current) {
      e.preventDefault()
      send()
    }
  }

  return (
    <div className="nodrag node-comments" role="dialog" aria-label="Comments" onKeyDown={onKeyDown}>
      <div className="node-comments__header">
        <span className="node-comments__title">Comments</span>
        <ToolbarButton label="Close" title="Close" data-title="Close" onClick={onClose}>
          <span className="codicon codicon-close" aria-hidden="true" />
        </ToolbarButton>
      </div>
      <div className="node-comments__list">
        {comments.length === 0 ? (
          <div className="node-comments__empty">No comments yet</div>
        ) : (
          comments.map((c) => (
            <div className="node-comments__item" key={c.id}>
              {c.text}
              <div className="node-comments__meta">
                {new Date(c.ts).toLocaleString()}{c.author ? ` · ${c.author}` : ''}
              </div>
            </div>
          ))
        )}
      </div>
      <div className="node-comments__composer">
        <textarea
          ref={inputRef}
          className="node-comments__input"
          rows={1}
          value={draft}
          placeholder="Add a comment…"
          aria-label="Add a comment"
          onChange={(e) => setDraft(e.target.value)}
        />
        <button type="button" className="node-comments__submit" title="Add Comment" onClick={send}>Add Comment</button>
      </div>
    </div>
  )
}
