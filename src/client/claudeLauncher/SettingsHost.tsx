// Settings panel host: also opens it on the section OPEN_SETTINGS_EVENT asks for (e.g. "Edit launch
// profile" in the Central card). Split out of App.tsx to keep it under the file-size limit.
import { useCallback, useState, type ComponentProps } from 'react'
import { SettingsPanel } from '../SettingsPanel'
import { useOpenSettingsEvent } from './useOpenSettingsEvent'

type SettingsHostProps = Omit<ComponentProps<typeof SettingsPanel>, 'onClose' | 'initialSection'> & {
  open: boolean
  setOpen: (open: boolean) => void
}

/** Always mounted (the event listener must be); renders the panel only while `open`. */
export default function SettingsHost({ open, setOpen, ...panel }: SettingsHostProps): React.JSX.Element | null {
  // `n` remounts an already open panel onto the requested section.
  const [at, setAt] = useState<{ section?: string; n: number }>({ n: 0 })
  useOpenSettingsEvent(useCallback((section: string) => { setAt((p) => ({ section, n: p.n + 1 })); setOpen(true) }, [setOpen]))
  if (!open) return null
  return <SettingsPanel key={at.n} initialSection={at.section} {...panel} onClose={() => { setOpen(false); setAt((p) => ({ n: p.n })) }} />
}
