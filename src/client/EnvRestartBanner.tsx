// Banner sticky "perlu restart" dari state server (entri pendingRestart), pakai label manusia.
import { SettingsMessage } from './SettingsMessage'
import { ENV_UI } from './envSectionLabels'
import { useEnvSettingsContext } from './useEnvSettings'

/** Daftar pengaturan yang menunggu restart server; kosong → tidak merender apa pun. */
export function EnvRestartBanner(): React.JSX.Element | null {
  const { state } = useEnvSettingsContext()
  const labels = (state?.entries ?? []).filter((e) => e.pendingRestart).map((e) => e.label)
  if (labels.length === 0) return null
  return (
    <div className="st-env-restart">
      <SettingsMessage kind="info" role="status">{ENV_UI.restartBanner} {labels.join(', ')}</SettingsMessage>
    </div>
  )
}
