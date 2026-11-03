// Kartu Telegram: tempel token, tautkan chat dengan satu ketukan (b §6).
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useTelegramCard } from './useTelegramCard'
import { TG } from './telegramCardLabels'

/** Kartu Telegram; `projectId` = proyek tujuan tautan chat (KE-10). */
export function TelegramCard({ projectId }: { projectId: string }): React.JSX.Element {
  const s = useTelegramCard(projectId)
  return (
    <section aria-label={TG.title} className="flex flex-col gap-2">
      <h3>{TG.title}</h3>
      {s.connecting ? <p role="status">{TG.connecting}</p> : null}
      {s.error ? <p role="alert">{s.error}</p> : null}
      {s.connected ? (
        <div className="flex items-center gap-2">
          <span role="status">{s.bot ? TG.connected(s.bot) : TG.connectedAnon}</span>
          <Button variant="outline" size="sm" onClick={() => void s.disconnect()}>{TG.disconnect}</Button>
        </div>
      ) : (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => { e.preventDefault(); void s.connect() }}
        >
          <p>{TG.intro}</p>
          <Label htmlFor="tg-token">{TG.tokenLabel}</Label>
          <Input
            id="tg-token" type="password" autoComplete="off" value={s.token}
            onChange={(e) => s.setToken(e.target.value)}
          />
          <Button type="submit" size="sm" disabled={s.connecting || s.token.trim() === ''}>{TG.connect}</Button>
        </form>
      )}
      {s.connected && s.pending.map((c) => (
        <div key={c.chatId} className="flex items-center gap-2">
          <span>{TG.pendingAsk(TG.chatName(c.chatId))}</span>
          <Button size="sm" onClick={() => void s.link(c)}>{TG.link}</Button>
          <Button variant="outline" size="sm" onClick={() => void s.ignore(c)}>{TG.ignore}</Button>
        </div>
      ))}
      {s.connected && s.bindings.length > 0 ? <h4>{TG.linkedHeading}</h4> : null}
      {s.connected && s.bindings.map((b) => (
        <div key={b.chatId} className="flex items-center gap-2">
          <span>{TG.chatName(b.chatId)}</span>
          <Button variant="outline" size="sm" onClick={() => void s.unbind(b)}>{TG.disconnect}</Button>
        </div>
      ))}
    </section>
  )
}
