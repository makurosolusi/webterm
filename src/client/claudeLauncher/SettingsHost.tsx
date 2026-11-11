// Settings panel host: the open section is the URL's `?settings=` (./appRoute), and OPEN_SETTINGS_EVENT
// (e.g. "Edit launch profile" in the Central card) opens it on the section the event asks for.
// Split out of App.tsx to keep it under the file-size limit.
import { lazy, Suspense, useCallback, useState, type ComponentProps } from 'react'
import { useOpenSettingsEvent } from './useOpenSettingsEvent'
import { toSettingsRouteSection, type SettingsRouteSection } from '../appRoute'

// The panel (and its many sections) loads on first open, not with the board.
const SettingsPanel = lazy(() => import('../SettingsPanel').then((m) => ({ default: m.SettingsPanel })))

type SettingsHostProps = Omit<ComponentProps<typeof SettingsPanel>, 'onClose' | 'initialSection' | 'section' | 'onSectionChange'> & {
  /** The section shown (`?settings=`); null = closed. */
  section: SettingsRouteSection | null
  /** Open (or switch to) a section. */
  onOpen: (section: SettingsRouteSection) => void
  onClose: () => void
}

/** Always mounted (the event listener must be); renders the panel only while a section is open. */
export default function SettingsHost({ section, onOpen, onClose, ...panel }: SettingsHostProps): React.JSX.Element | null {
  // The event's raw id, kept while the URL still shows its section: `background:workspace` says more than
  // `?settings=background` (the scope). A reload drops it and opens the section's default scope.
  // `n` remounts an already open panel so that hint applies.
  const [raw, setRaw] = useState<{ id: string; n: number }>({ id: '', n: 0 })
  useOpenSettingsEvent(useCallback((id: string) => {
    setRaw((p) => ({ id, n: p.n + 1 }))
    onOpen(toSettingsRouteSection(id))
  }, [onOpen]))
  if (!section) return null
  const shown = raw.id && toSettingsRouteSection(raw.id) === section ? raw.id : section
  const forget = (): void => setRaw((p) => ({ id: '', n: p.n }))
  return (
    <Suspense fallback={null}>
      <SettingsPanel key={raw.n} section={shown} {...panel}
        onSectionChange={(id) => { forget(); onOpen(id as SettingsRouteSection) }}
        onClose={() => { forget(); onClose() }} />
    </Suspense>
  )
}
