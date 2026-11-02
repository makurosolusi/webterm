// Combined Inbox + Chat bottom panel: one VS Code panel surface with a tab per pane.
//
// App still mounts `InboxPanel` and `ChatPanel` separately (each renders its own single-tab
// surface). This shell is the two-tab mount for an integrator that owns both toggles: it keeps
// both panes mounted while the panel is open, so switching tabs never restarts an inbox fetch,
// drops an approval dialog, or reopens the chat stream. Only the inactive pane is hidden.
import { useEffect, useState } from 'react'
import { MessageSquare, ShieldAlert } from 'lucide-react'
import InboxPanel, { type InboxPanelProps } from './InboxPanel'
import ChatPanel, { type ChatPanelProps } from './ChatPanel'
import { InboxPanelSurface } from './inboxPanelSurface'
import type { VscodeEditorTab } from './components/vscode/vscodeEditorTabBar'

export type InboxChatTabId = 'inbox' | 'chat'

export interface InboxChatPanelProps {
  inboxOpen?: boolean
  chatOpen?: boolean
  onCloseInbox?: () => void
  onCloseChat?: () => void
  /** Everything except the shell-owned `open`, `onClose`, and `embedded`. */
  inbox?: Omit<InboxPanelProps, 'open' | 'onClose' | 'embedded'>
  /** Everything except the shell-owned `open`, `onClose`, `embedded`, and stacked offset. */
  chat?: Omit<ChatPanelProps, 'open' | 'onClose' | 'embedded' | 'offsetForInbox'>
}

/** True when at least one pane is open; the shell owns tab selection only while open. */
export function inboxChatTabOpen(tab: InboxChatTabId, inboxOpen: boolean, chatOpen: boolean): boolean {
  return tab === 'inbox' ? inboxOpen : chatOpen
}

export default function InboxChatPanel(props: InboxChatPanelProps): React.JSX.Element | null {
  const inboxOpen = props.inboxOpen ?? true
  const chatOpen = props.chatOpen ?? true
  const [active, setActive] = useState<InboxChatTabId>(inboxOpen ? 'inbox' : 'chat')

  // Active tab must always name an open pane. Closing the active tab hands focus to the
  // other open pane instead of leaving an empty body under a stale tab.
  useEffect(() => {
    if (inboxChatTabOpen(active, inboxOpen, chatOpen)) return
    if (inboxOpen) setActive('inbox')
    else if (chatOpen) setActive('chat')
  }, [active, inboxOpen, chatOpen])

  if (!inboxOpen && !chatOpen) return null

  const tabs: VscodeEditorTab[] = []
  if (inboxOpen) {
    tabs.push({
      id: 'inbox',
      label: 'Inbox',
      icon: <ShieldAlert size={14} aria-hidden="true" />,
      tooltip: 'Operator inbox and approvals',
      closable: props.onCloseInbox !== undefined,
    })
  }
  if (chatOpen) {
    tabs.push({
      id: 'chat',
      label: 'Chat',
      icon: <MessageSquare size={14} aria-hidden="true" />,
      tooltip: 'Central agent',
      closable: props.onCloseChat !== undefined,
    })
  }

  const closeTab = (id: string): void => {
    if (id === 'inbox') props.onCloseInbox?.()
    else if (id === 'chat') props.onCloseChat?.()
  }

  return (
    <InboxPanelSurface
      className="inbox-chat-panel"
      ariaLabel="Inbox and Chat"
      tabsLabel="Inbox and Chat tabs"
      tabs={tabs}
      activeId={active}
      onActivate={(id) => setActive(id === 'chat' ? 'chat' : 'inbox')}
      {...(props.onCloseInbox === undefined && props.onCloseChat === undefined
        ? {}
        : { onClose: closeTab })}
    >
      <div className="vscode-bottom-panel__pane" hidden={active !== 'inbox'}>
        <InboxPanel {...props.inbox} open={inboxOpen} embedded
          {...(props.onCloseInbox === undefined ? {} : { onClose: props.onCloseInbox })} />
      </div>
      <div className="vscode-bottom-panel__pane" hidden={active !== 'chat'}>
        <ChatPanel {...props.chat} open={chatOpen} embedded
          {...(props.onCloseChat === undefined ? {} : { onClose: props.onCloseChat })} />
      </div>
    </InboxPanelSurface>
  )
}
