// App-side listener for OPEN_SETTINGS_EVENT (e.g. "Edit launch profile" in the Central card,
// which can be rendered far from App: inside Settings itself, a Dock offer or a canvas menu).
import { useEffect } from 'react'
import { OPEN_SETTINGS_EVENT } from './claudeLaunch.client'

export function useOpenSettingsEvent(open: (section: string) => void): void {
  useEffect(() => {
    const on = (e: Event): void => {
      const section = (e as CustomEvent<{ section?: unknown }>).detail?.section
      open(typeof section === 'string' ? section : 'terminal')
    }
    window.addEventListener(OPEN_SETTINGS_EVENT, on)
    return () => window.removeEventListener(OPEN_SETTINGS_EVENT, on)
  }, [open])
}
