// Pesan inline ala VS Code (ikon codicon + teks) untuk info/warning/error di dalam Settings.
import type { ReactNode } from 'react'

const ICON = { info: 'codicon-info', warning: 'codicon-warning', error: 'codicon-error' } as const

/** Pesan satu baris dengan ikon severity; `role` diteruskan bila pesan harus diumumkan. */
export function SettingsMessage({
  kind,
  role,
  children,
}: {
  kind: keyof typeof ICON
  role?: 'alert' | 'status'
  children: ReactNode
}): React.JSX.Element {
  return (
    <p className={`st-message st-message--${kind}`} role={role}>
      <span className={`codicon ${ICON[kind]}`} aria-hidden="true" />
      <span>{children}</span>
    </p>
  )
}
