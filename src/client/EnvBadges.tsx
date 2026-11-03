// Badge status baris env: Diubah, Perlu restart, Berbahaya, Dari .env, Dikunci (tanpa badge default).
import { ENV } from './envLabels'
import { isChanged, needsRestart } from './envRequires'
import type { EnvEntry } from './envSettingsApi'

interface Props {
  entry: EnvEntry
  /** Nilai yang sedang ditampilkan (draft bila ada). */
  shown: string
  /** id elemen `dangerNote`, dirujuk badge Berbahaya lewat aria-describedby. */
  dangerId?: string
}

/** Kumpulan badge sebuah baris; hanya badge yang berlaku yang dirender. */
export function EnvBadges({ entry, shown, dangerId }: Props): React.JSX.Element {
  return (
    <>
      {isChanged(entry, shown) ? <span className="st-tag st-tag--modified">{ENV.badgeChanged}</span> : null}
      {needsRestart(entry) ? <span className="st-tag">{ENV.badgeRestart}</span> : null}
      {entry.dangerous ? (
        <span className="st-tag st-tag--warning" aria-describedby={entry.dangerNote ? dangerId : undefined}>
          <span className="codicon codicon-warning" aria-hidden="true" />{ENV.badgeDangerous}
        </span>
      ) : null}
      {entry.source === 'env' ? <span className="st-tag" title={ENV.badgeEnvTitle}>{ENV.badgeEnv}</span> : null}
      {!entry.editable ? <span className="st-tag" title={ENV.badgeLockedTitle}>{ENV.badgeLocked}</span> : null}
    </>
  )
}
