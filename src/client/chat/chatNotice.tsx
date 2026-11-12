// One compact centered line for a system notice (session switched, compaction, a warning), shared by the
// Central chat and the Agent Chat node: no role header, muted, the time on hover. Warnings and errors keep
// their icon and colour so they never read as routine.
import './chatNotice.css'

export type ChatNoticeLevel = 'info' | 'warn' | 'error'

const ICON: Record<Exclude<ChatNoticeLevel, 'info'>, string> = { warn: 'warning', error: 'error' }

/** `time` (epoch ms) shows as the tooltip; 0 or absent = no tooltip. */
export function ChatNotice({ text, level = 'info', time }: { text: string; level?: ChatNoticeLevel; time?: number }) {
  const title = time ? new Date(time).toLocaleString() : undefined
  return (
    <div className={`chat-notice chat-notice--${level}`} role="status" title={title}>
      {level !== 'info' && <span className={`codicon codicon-${ICON[level]}`} aria-hidden="true" />}
      <span className="chat-notice__text">{text}</span>
    </div>
  )
}
