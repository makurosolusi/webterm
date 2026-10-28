import { useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { Comment } from '../shared/workspace'

export interface NodeCommentsProps {
  comments: Comment[]
  onAdd: (text: string) => void
  onClose: () => void
}

export default function NodeComments({ comments, onAdd, onClose }: NodeCommentsProps) {
  const [draft, setDraft] = useState('')

  const send = () => {
    const text = draft.trim()
    if (!text) return
    onAdd(text)
    setDraft('')
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  return (
    <div className="node-comments">
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
          className="field"
          value={draft}
          placeholder="Add a comment…"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <button className="icon-btn" title="Send" onClick={send}>Send</button>
        <button className="icon-btn" title="Close" onClick={onClose}>×</button>
      </div>
    </div>
  )
}
