// "Secret usage" card of Settings › Rules & secrets: every use of a secret, newest first, as the broker logged it
// (a hash of the command, never the command line itself).
import { whoText } from './policyPresets'
import { CardEmpty } from './SettingsCardState'
import { SettingsGroup } from './SettingsControls'
import { SECRETS_TEXT as T } from './secretsLabels'

export interface SecretUse { seq: number; ts: number; name: string; principal: string; commandHash: string; exitCode: number | null }

const FINGERPRINT_CHARS = 12
const result = (code: number | null): string => (code === null ? T.noResult : code === 0 ? T.ok : T.exitFailed(code))

/** `usage` null = the ledger is off (no log at all), [] = nothing used yet. */
export function SecretsUsage({ usage }: { usage: SecretUse[] | null }): React.JSX.Element {
  return (
    <SettingsGroup title={T.usageTitle} description={T.usageIntro}>
      {usage === null ? <CardEmpty text={T.usageOff} /> : null}
      {usage?.length === 0 ? <CardEmpty text={T.usageEmpty} /> : null}
      {usage && usage.length > 0 ? (
        <div className="st-table-wrap">
          <table className="st-table" aria-label={T.usageTitle}>
            <thead>
              <tr>{[T.colWhen, T.colName, T.colWho, T.colCommand, T.colResult].map((h) => <th key={h} scope="col">{h}</th>)}</tr>
            </thead>
            <tbody>
              {usage.map((u) => (
                <tr key={u.seq} data-use={u.seq}>
                  <td>{new Date(u.ts).toLocaleString()}</td>
                  <td><code>{u.name}</code></td>
                  <td>{whoText(u.principal)}</td>
                  <td><code>{u.commandHash.slice(0, FINGERPRINT_CHARS)}</code></td>
                  <td>{result(u.exitCode)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </SettingsGroup>
  )
}
