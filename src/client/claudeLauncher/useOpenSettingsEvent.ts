// App-side listener for OPEN_SETTINGS_EVENT (e.g. "Edit launch profile" in the Central card,
// which can be rendered far from App: inside Settings itself, a Dock offer or a canvas menu).
import { useEffect } from 'react'
import { OPEN_SETTINGS_EVENT, toSettingsFieldId, type SettingsFieldId } from '../settings.link'

/** `open(section, field)`: field = the setting the link names (null = the whole section; unknown ids dropped). */
export function useOpenSettingsEvent(open: (section: string, field: SettingsFieldId | null) => void): void {
  useEffect(() => {
    const on = (e: Event): void => {
      const detail = (e as CustomEvent<{ section?: unknown; field?: unknown }>).detail
      const section = detail?.section
      open(typeof section === 'string' ? section : 'terminal', toSettingsFieldId(typeof detail?.field === 'string' ? detail.field : null))
    }
    window.addEventListener(OPEN_SETTINGS_EVENT, on)
    return () => window.removeEventListener(OPEN_SETTINGS_EVENT, on)
  }, [open])
}
