// The conversation list of the chat panel (global, extra chats, project scopes): rows with unread / running
// marks and the "Show more" pager. Presentational; ChatPanel owns selection and the feed.
import { cn } from '@/lib/utils'
import { loadMore, type useChatFeed } from './chatFeed'
import type { ChatConversation } from './chatTypes'
import { conversationLabel } from './chatTypes'
import { relativeTime } from '../SessionHistory.model'

export interface ChatConversationListProps {
  /** Rows to show; null until the first load lands. */
  conversations: ChatConversation[] | null
  feed: ReturnType<typeof useChatFeed>
  selected: string | null
  /** A row was clicked. */
  onPick: (id: string) => void
}

/** The conversations column (or the History view of a narrow host). */
export function ChatConversationList({ conversations, feed, selected, onPick }: ChatConversationListProps) {
  return (
    <nav className="chat-conversations" aria-label="Conversations" aria-busy={feed.refreshing || undefined}>
      {conversations === null ? (
        feed.loading && <p className="chat-list-status">Loading…</p>
      ) : conversations.length === 0 ? (
        <p className="chat-list-status">No conversations yet</p>
      ) : (
        <ul className="chat-list">
          {conversations.map((conversation) => {
            const isUnread = feed.unread.has(conversation.id)
            const running = conversation.activeTurnId !== null
            return (
            <li key={conversation.id}>
              <button
                type="button"
                className={cn('chat-list-item', conversation.id === selected && 'is-active', isUnread && 'is-unread')}
                aria-current={conversation.id === selected ? 'true' : undefined}
                aria-label={isUnread ? `${conversationLabel(conversation)}, unread${running ? ', turn running' : ''}` : undefined}
                onClick={() => onPick(conversation.id)}
              >
                <span className="chat-list-item__label">{conversationLabel(conversation)}</span>
                {isUnread && <span className="chat-list-item__unread" title="Unread" aria-hidden="true" />}
                {conversation.updatedAt > 0 && (
                  <span className="chat-list-item__time">{relativeTime(conversation.updatedAt)}</span>
                )}
                {conversation.activeTurnId !== null && (
                  <span className="chat-list-item__live" title="Turn running" aria-label="Turn running" />
                )}
              </button>
            </li>
            )
          })}
          {feed.nextOffset !== null && (
            <li className="chat-list-more">
              {feed.more.error !== null && <p className="chat-list-status" role="alert">{feed.more.error}</p>}
              <button type="button" className="chat-list-item" disabled={feed.more.loading}
                aria-busy={feed.more.loading || undefined} onClick={loadMore}>
                <span className="chat-list-item__label">
                  {feed.more.loading ? 'Loading…' : feed.more.error !== null ? 'Retry' : 'Show more'}
                </span>
              </button>
            </li>
          )}
        </ul>
      )}
    </nav>
  )
}
