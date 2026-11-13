// Settings page header: icon + title (the largest text of the page), the page's description, and
// "Reset page…" when any setting on the page differs from its default (macOS "Restore Defaults").
// The page's settings are the search index entries whose field is a Settings key, so the list cannot
// drift from what the page shows (settings.search.policy.test.ts locks the index to the page).
import { useState } from 'react'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { DEFAULT_SETTINGS, type Settings } from '../shared/settings'
import type { SettingsPatch } from '../shared/settings.patch'
import { SETTINGS_SEARCH_INDEX } from './settings.search'
import { isModified, resetPatch } from './settingsContext'
import type { SETTINGS_SECTIONS, SectionId } from './settingsSections.registry'

export const PAGE_TEXT = {
  resetPage: 'Reset page…',
  confirmTitle: (n: number, page: string): string => `Reset ${n} ${n === 1 ? 'setting' : 'settings'} on ${page}?`,
  confirmBody: (labels: string): string => `These go back to their defaults: ${labels}. Undo is offered right after.`,
  reset: 'Reset',
  cancel: 'Cancel',
} as const

const isSettingKey = (field: string | undefined): field is keyof Settings => !!field && Object.hasOwn(DEFAULT_SETTINGS, field)

/** The page's settings that differ from their defaults, in page order. */
export function modifiedOnPage(page: SectionId, s: Settings): { key: keyof Settings; label: string }[] {
  return SETTINGS_SEARCH_INDEX.flatMap((x) => (x.page === page && isSettingKey(x.field) && isModified(s, x.field) ? [{ key: x.field, label: x.label }] : []))
}

/** One patch that resets every listed key (each key's own reset, so lists and entry maps clear too). */
export function resetPagePatch(keys: readonly (keyof Settings)[], s: Settings): SettingsPatch {
  return Object.assign({}, ...keys.map((k) => resetPatch(k, s))) as SettingsPatch
}

export function SettingsPageHeader({ section, settings, onChange }: {
  section: (typeof SETTINGS_SECTIONS)[number]
  settings: Settings
  onChange(patch: SettingsPatch): void
}): React.JSX.Element {
  const [confirming, setConfirming] = useState(false)
  const modified = modifiedOnPage(section.id, settings)
  return (
    <header className="st-section-head">
      <div className="st-section-head-row">
        <h2 className="st-section-title">
          <span className={`codicon codicon-${section.icon}`} aria-hidden="true" />
          {section.label}
        </h2>
        {modified.length ? (
          <button type="button" className="st-button st-reset-page" onClick={() => setConfirming(true)}>{PAGE_TEXT.resetPage}</button>
        ) : null}
      </div>
      <p className="st-section-desc">{section.description}</p>
      {confirming ? (
        <AlertDialog open onOpenChange={(open) => { if (!open) setConfirming(false) }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{PAGE_TEXT.confirmTitle(modified.length, section.label)}</AlertDialogTitle>
              <AlertDialogDescription>{PAGE_TEXT.confirmBody(modified.map((m) => m.label).join(', '))}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel autoFocus>{PAGE_TEXT.cancel}</AlertDialogCancel>
              <AlertDialogAction variant="destructive" onClick={() => onChange(resetPagePatch(modified.map((m) => m.key), settings))}>{PAGE_TEXT.reset}</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </header>
  )
}
