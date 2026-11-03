// Kartu "Info server": status read-only (token root terisi/kosong, pengaturan terkunci) tanpa nilai rahasia.
import { useId } from 'react'
import type { EnvStateV2 } from '../shared/envSettings.contract'
import { SettingsMessage } from './SettingsMessage'
import { ENV } from './envLabels'
import { ENV_UI } from './envSectionLabels'

/** Info server read-only; satu langkah tindakan bila gerbang root (WEBTERM_TOKEN) belum aktif. */
export function EnvServerCard({ server, rootGate }: Pick<EnvStateV2, 'server' | 'rootGate'>): React.JSX.Element {
  const id = useId()
  return (
    <section className="st-env-server" aria-labelledby={id}>
      <h4 className="st-env-heading" id={id}>{ENV_UI.serverTitle}</h4>
      <dl className="st-env-server-list">
        <dt>{ENV_UI.serverToken}</dt>
        <dd>{server.tokenSet ? ENV_UI.tokenSet : ENV_UI.tokenUnset}</dd>
        <dt>{ENV_UI.serverSettings}</dt>
        <dd>{server.settingsLocked ? ENV.serverSettingsLocked : ENV.serverSettingsOpen}</dd>
      </dl>
      {rootGate ? null : <SettingsMessage kind="warning">{ENV.noRootGate}</SettingsMessage>}
    </section>
  )
}
