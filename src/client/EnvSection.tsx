// Section "Environment" di Settings: variabel env (dulu hanya dari .env) dengan default + override.
// Hook data hanya hidup selama section dirender (pencarian lintas section tidak memasangnya).
import { useId } from 'react'
import { Button } from '@/components/ui/button'
import { useSettingsSearch } from './SettingsFields'
import { EnvEntryRow } from './EnvEntryRow'
import { ENV, ENV_BOOTSTRAP_GROUP, ENV_GROUP_LABEL, ENV_GROUP_ORDER } from './envLabels'
import type { EnvEntry } from './envSettingsApi'
import { useEnvSettings } from './useEnvSettings'
import './settings-env.css'

/** Section Environment; kosong saat pencarian aktif. */
export function EnvSection(): React.JSX.Element | null {
  const query = useSettingsSearch()
  return query ? null : <EnvPanel />
}

/** Kelompokkan per group: urutan tetap, group tak dikenal sebelum bootstrap, bootstrap terakhir. */
function groupEntries(entries: EnvEntry[]): Array<[string, EnvEntry[]]> {
  const groups = new Map<string, EnvEntry[]>()
  for (const e of entries) groups.set(e.group, [...(groups.get(e.group) ?? []), e])
  const rank = (g: string): number => {
    if (g === ENV_BOOTSTRAP_GROUP) return Number.MAX_SAFE_INTEGER
    const i = (ENV_GROUP_ORDER as readonly string[]).indexOf(g)
    return i === -1 ? ENV_GROUP_ORDER.length : i
  }
  return [...groups].sort((a, b) => rank(a[0]) - rank(b[0]))
}

function BootstrapRow({ entry }: { entry: EnvEntry }): React.JSX.Element {
  return (
    <li className="st-env-row" aria-label={entry.key}>
      <div className="st-env-head">
        <code className="st-mono">{entry.key}</code>
        <span className="st-muted">{entry.set ? ENV.secretSet : ENV.secretUnset} · {ENV.bootstrapOnly}</span>
      </div>
    </li>
  )
}

function EnvPanel(): React.JSX.Element {
  const e = useEnvSettings()
  const uid = useId()
  const locked = e.state?.locked ?? false
  const save = (key: string, value: string): Promise<boolean> => e.apply(key, { set: { [key]: value } })
  const unset = (key: string): Promise<boolean> => e.apply(key, { unset: [key] })
  return (
    <div className="st-env" aria-busy={e.loading}>
      <div className="st-ch-toolbar">
        <Button type="button" variant="outline" size="sm" className="st-button" onClick={e.refresh}>
          {ENV.refresh}
        </Button>
      </div>
      {e.loading ? <p className="st-note" role="status">{ENV.loading}</p> : null}
      {e.error ? <p className="st-ch-err" role="alert">{e.error}</p> : null}
      {locked ? <p className="st-env-banner" role="status">{ENV.lockedBanner}</p> : null}
      {e.restartKeys.length > 0 ? (
        <p className="st-env-banner" role="status">{ENV.restartBanner} {e.restartKeys.join(', ')}</p>
      ) : null}
      {e.state ? groupEntries(e.state.entries).map(([group, entries]) => (
        <section key={group} aria-labelledby={`${uid}-${group}`}>
          <h3 className="st-ch-heading" id={`${uid}-${group}`}>{ENV_GROUP_LABEL[group] ?? group}</h3>
          <ul className="st-ch-list">
            {entries.map((entry) => group === ENV_BOOTSTRAP_GROUP ? (
              <BootstrapRow key={entry.key} entry={entry} />
            ) : (
              <EnvEntryRow key={entry.key} entry={entry} locked={locked} busy={e.busy}
                error={e.entryErrors[entry.key]} onSave={save} onUnset={unset} />
            ))}
          </ul>
        </section>
      )) : null}
    </div>
  )
}
