import { useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { Comment } from '../shared/workspace'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'

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
    <div className="nodrag node-comments">
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
        <Textarea
          value={draft}
          placeholder="Add a comment…"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <Button variant="default" size="sm" title="Send" onClick={send}>Send</Button>
        <Button variant="ghost" size="icon-xs" title="Close" onClick={onClose}>×</Button>
      </div>
    </div>
  )
}
