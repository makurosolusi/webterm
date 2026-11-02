// Section "Channels" di Settings: status channel Telegram, chat pending, dan binding aktif.
// Hook data hanya hidup selama section dirender (pencarian lintas section tidak memasangnya).
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Field, useSettingsSearch } from './SettingsFields'
import { ChannelsBindings, ChannelsPending } from './ChannelsLists'
import type { DirectionStatus, TelegramStatus } from './channelsApi'
import { CH, relativeTime } from './channelsLabels'
import { useChannels } from './useChannels'
import './settings-channels.css'

/** Section Channels; kosong saat pencarian aktif supaya tidak polling di belakang hasil cari. */
export function ChannelsSection(): React.JSX.Element | null {
  const query = useSettingsSearch()
  return query ? null : <ChannelsPanel />
}

function Direction({ label, dir, now }: { label: string; dir: DirectionStatus; now: number }): React.JSX.Element {
  const ok = dir.lastOk === undefined ? CH.never : relativeTime(dir.lastOk, now)
  return (
    <Field label={label}>
      <div className="st-ch-dir">
        <span>{CH.lastOk}: {ok}</span>
        <span>{dir.okCount} {CH.okCount} / {dir.errorCount} {CH.errorCount}</span>
        {dir.lastError ? (
          <span className="st-ch-err">
            {CH.lastError} ({relativeTime(dir.lastError.at, now)}): {dir.lastError.message}
          </span>
        ) : null}
      </div>
    </Field>
  )
}

function StatusBlock({ status, now }: { status: TelegramStatus; now: number }): React.JSX.Element {
  return (
    <>
      <Field label={CH.mode}>{status.mode === 'webhook' ? CH.modeWebhook : CH.modePoll}</Field>
      <Field label={CH.botToken}>{status.botTokenSet ? CH.set : CH.unset}</Field>
      {status.mode === 'webhook' ? (
        <Field label={CH.webhookSecret}>{status.webhookSecretSet ? CH.set : CH.unset}</Field>
      ) : null}
      <Direction label={CH.ingress} dir={status.ingress} now={now} />
      <Direction label={CH.egress} dir={status.egress} now={now} />
    </>
  )
}

function ChannelsPanel(): React.JSX.Element {
  const c = useChannels()
  const now = Date.now()
  let body: ReactNode
  if (c.loading) {
    body = <p className="st-note" role="status">{CH.loading}</p>
  } else if (c.inactive) {
    body = (
      <div className="st-ch-inactive" role="status">
        <strong>{CH.inactiveTitle}</strong>
        <p className="st-note">{CH.inactiveHint}</p>
      </div>
    )
  } else if (c.status) {
    body = (
      <>
        <h3 className="st-ch-heading">{CH.statusHeading}</h3>
        <StatusBlock status={c.status} now={now} />
        <ChannelsPending items={c.pending} bindings={c.bindings} busy={c.busy} act={c.act} now={now} />
        <ChannelsBindings items={c.bindings} busy={c.busy} act={c.act} />
      </>
    )
  }
  return (
    <div className="st-ch" aria-busy={c.loading}>
      <div className="st-ch-toolbar">
        <Button type="button" variant="outline" size="sm" className="st-button" onClick={c.refresh}>
          {CH.refresh}
        </Button>
      </div>
      {c.error ? <p className="st-ch-err" role="alert">{c.error}</p> : null}
      {c.actionError ? <p className="st-ch-err" role="alert">{c.actionError}</p> : null}
      {body}
    </div>
  )
}
