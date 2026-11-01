// Small helpers/state for InboxPanel. Dipisah supaya komponen utama tetap di bawah batas file.
import { useEffect, useState } from 'react'
import type { InboxState } from './inboxApi'

export const SECTION_ORDER: readonly InboxState[] = ['needs_you', 'review', 'broken']

export const SECTION_LABEL: Record<InboxState, string> = {
  needs_you: 'Needs you',
  review: 'Review',
  broken: 'Broken',
}

export const OPEN_KEY = 'webterm.inboxOpen'

export const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** Open/closed state for the Dock toggle, persisted like `useSessionsOpen`. */
export function useInboxOpen(): readonly [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(OPEN_KEY) !== '0'
    } catch {
      return true
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem(OPEN_KEY, open ? '1' : '0')
    } catch {
      // Private mode: the choice lasts for this tab only.
    }
  }, [open])
  return [open, setOpen] as const
}

export function formatAge(ageMs: number): string {
  const seconds = Math.max(0, Math.floor(ageMs / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}
