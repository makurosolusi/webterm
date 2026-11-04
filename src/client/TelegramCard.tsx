// Kartu Telegram: tempel token, tautkan chat lewat tautan pairing (t.me/<bot>?start=<kode>) atau
// satu ketukan dari daftar chat menunggu (b §6).
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { PairingLink } from './telegramCardApi'
import { useTelegramCard } from './useTelegramCard'
import { TG } from './telegramCardLabels'

function PairingBlock({ pair }: { pair: PairingLink }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const copy = (): void => {
    void navigator.clipboard?.writeText(pair.link).then(() => setCopied(true), () => setCopied(false))
  }
  return (
    <div className="flex flex-col gap-2">
      <p>{TG.pairIntro(pair.projectName)}</p>
      <a href={pair.link} target="_blank" rel="noreferrer">{TG.pairOpen}</a>
      <div className="flex items-center gap-2">
        <Input aria-label={TG.pairLinkLabel} readOnly value={pair.link} onFocus={(e) => e.target.select()} />
        <Button variant="outline" size="sm" onClick={copy}>{copied ? TG.copied : TG.copy}</Button>
      </div>
    </div>
  )
}

/** Kartu Telegram; `projectId` = proyek tujuan tautan chat (KE-10). */
export function TelegramCard({ projectId }: { projectId: string }): React.JSX.Element {
  const s = useTelegramCard(projectId)
  const project = s.projectName ?? projectId
  const hasProject = projectId !== ''
  return (
    <section aria-label={TG.title} className="flex flex-col gap-2">
      <h3>{TG.title}</h3>
      {s.connecting ? <p role="status">{TG.connecting}</p> : null}
      {s.error ? <p role="alert">{s.error}</p> : null}
      {s.connected ? (
        <div className="flex items-center gap-2">
          <span role="status">{s.status}</span>
          <Button variant="outline" size="sm" onClick={() => void s.stopBot()}>{TG.stopBot}</Button>
        </div>
      ) : (
        <>
          {s.tokenStored ? (
            <div className="flex items-center gap-2">
              <span>{TG.restartHint}</span>
              <Button size="sm" onClick={() => void s.restart()}>{TG.restart}</Button>
            </div>
          ) : null}
          <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); void s.connect() }}>
            <p>{s.tokenStored ? TG.orNewToken : TG.intro}</p>
            <Label htmlFor="tg-token">{TG.tokenLabel}</Label>
            <Input
              id="tg-token" type="password" autoComplete="off" value={s.token}
              onChange={(e) => s.setToken(e.target.value)}
            />
            <Button type="submit" size="sm" disabled={s.connecting || s.token.trim() === ''}>{TG.connect}</Button>
          </form>
        </>
      )}
      {s.connected && !hasProject ? <p>{TG.noProject}</p> : null}
      {s.connected && s.pair ? <PairingBlock pair={s.pair} /> : null}
      {s.connected && hasProject && s.pending.map((c) => (
        <div key={c.chatId} className="flex items-center gap-2">
          <span>{TG.pendingAsk(TG.chatName(c.chatId), project)}</span>
          <Button size="sm" onClick={() => void s.link(c)}>{TG.link}</Button>
          <Button variant="outline" size="sm" onClick={() => void s.ignore(c)}>{TG.ignore}</Button>
        </div>
      ))}
      {s.connected && s.bindings.length > 0 ? <h4>{TG.linkedHeading}</h4> : null}
      {s.connected && s.bindings.map((b) => (
        <div key={b.chatId} className="flex items-center gap-2">
          <span>{TG.linkedRow(TG.chatName(b.chatId), b.projectId === projectId ? project : b.projectId)}</span>
          <Button variant="outline" size="sm" onClick={() => void s.unbind(b)}>{TG.unlink}</Button>
        </div>
      ))}
    </section>
  )
}
