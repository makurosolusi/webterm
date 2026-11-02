// Daftar pending (bind / abaikan) dan binding aktif (hapus dengan konfirmasi) untuk section Channels.
import { useId, useState } from 'react'
import { SettingsMessage } from './SettingsMessage'
import { Input } from '@/components/ui/input'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  CHANNEL_ROLES,
  GROUP_ROLES,
  bindChat,
  ignorePending,
  projectIdProblem,
  unbindChat,
  type ChannelRole,
  type PendingChat,
  type TelegramBinding,
} from './channelsApi'
import { CH, relativeTime } from './channelsLabels'

type Act = (fn: () => Promise<void>) => Promise<boolean>
const ROLE_LABEL: Record<ChannelRole, string> = {
  viewer: CH.roleViewer,
  operator: CH.roleOperator,
  approver: CH.roleApprover,
  owner: CH.roleOwner,
}
/** Chat grup (id negatif) hanya boleh role terbatas; server menolak selain itu. */
const rolesFor = (chatId: string): readonly ChannelRole[] => (chatId.startsWith('-') ? GROUP_ROLES : CHANNEL_ROLES)

function PendingRow({ chat, listId, busy, act, now }: {
  chat: PendingChat; listId: string; busy: boolean; act: Act; now: number
}): React.JSX.Element {
  const [role, setRole] = useState<ChannelRole>('viewer')
  const [projectId, setProjectId] = useState('')
  const [touched, setTouched] = useState(false)
  const problem = projectIdProblem(projectId)
  const uid = useId()
  return (
    <li className="st-ch-row" aria-label={chat.chatId}>
      <div className="st-ch-meta">
        <code className="st-mono">{chat.chatId}</code>
        <span className="st-muted">{chat.count} {CH.messages} · {CH.lastSeen} {relativeTime(chat.lastSeen, now)}</span>
      </div>
      <div role="radiogroup" aria-label={`${CH.role} ${chat.chatId}`} className="st-chips">
        {rolesFor(chat.chatId).map((r) => (
          <button key={r} type="button" role="radio" aria-checked={role === r}
            className={'st-button' + (role === r ? ' is-active' : '')} onClick={() => setRole(r)}>
            {ROLE_LABEL[r]}
          </button>
        ))}
      </div>
      <label className="st-sr-only" htmlFor={`${uid}-proj`}>{CH.projectId} {chat.chatId}</label>
      <Input id={`${uid}-proj`} className="st-input st-mono" type="text" list={listId}
        placeholder={CH.projectIdPlaceholder} value={projectId} aria-invalid={touched && problem !== null}
        onChange={(e) => { setProjectId(e.target.value); setTouched(true) }} />
      <button type="button" className="st-button st-button--primary" disabled={busy}
        onClick={() => {
          setTouched(true)
          if (problem === null) void act(() => bindChat({ projectId: projectId.trim(), chatId: chat.chatId, role }))
        }}>
        {CH.bind}
      </button>
      <button type="button" className="st-button" disabled={busy}
        onClick={() => void act(() => ignorePending(chat.chatId))}>
        {CH.ignore}
      </button>
      {touched && problem ? <div className="st-ch-rowerr"><SettingsMessage kind="error" role="alert">{problem}</SettingsMessage></div> : null}
    </li>
  )
}

/** Chat yang menghubungi bot tapi belum ter-bind. */
export function ChannelsPending({ items, bindings, busy, act, now }: {
  items: PendingChat[]; bindings: TelegramBinding[]; busy: boolean; act: Act; now: number
}): React.JSX.Element {
  const listId = useId()
  const known = [...new Set(bindings.map((b) => b.projectId))]
  return (
    <section aria-labelledby={`${listId}-h`}>
      <h3 className="st-ch-heading" id={`${listId}-h`}>{CH.pendingHeading}</h3>
      <p className="st-note">{CH.pendingHint}</p>
      <datalist id={listId}>{known.map((p) => <option key={p} value={p} />)}</datalist>
      {items.length === 0 ? <p className="st-note">{CH.pendingEmpty}</p> : (
        <ul className="st-ch-list">
          {items.map((c) => <PendingRow key={c.chatId} chat={c} listId={listId} busy={busy} act={act} now={now} />)}
        </ul>
      )}
    </section>
  )
}

/** Binding aktif; hapus lewat dialog konfirmasi. */
export function ChannelsBindings({ items, busy, act }: {
  items: TelegramBinding[]; busy: boolean; act: Act
}): React.JSX.Element {
  const [target, setTarget] = useState<string | null>(null)
  const id = useId()
  return (
    <section aria-labelledby={`${id}-h`}>
      <h3 className="st-ch-heading" id={`${id}-h`}>{CH.bindingsHeading}</h3>
      {items.length === 0 ? <p className="st-note">{CH.bindingsEmpty}</p> : (
        <ul className="st-ch-list">
          {items.map((b) => (
            <li key={b.chatId} className="st-ch-row" aria-label={b.chatId}>
              <div className="st-ch-meta">
                <code className="st-mono">{b.chatId}</code>
                <span className="st-muted">{b.projectId} · {ROLE_LABEL[b.role] ?? b.role}</span>
              </div>
              <button type="button" className="st-button" disabled={busy}
                aria-label={`${CH.remove} ${b.chatId}`} onClick={() => setTarget(b.chatId)}>
                {CH.remove}
              </button>
            </li>
          ))}
        </ul>
      )}
      <AlertDialog open={target !== null} onOpenChange={(open) => { if (!open) setTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{CH.removeTitle}</AlertDialogTitle>
            <AlertDialogDescription>{target} — {CH.removeDescription}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{CH.cancel}</AlertDialogCancel>
            <AlertDialogAction onClick={() => { if (target) void act(() => unbindChat(target)) }}>
              {CH.remove}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
