import type { ReactNode } from 'react'
import { Badge } from '@/components/ui/badge'

// Fill color by % of context USED. Exported so logic has no bare hex (Rule 15).
export const USAGE_RED = '#ff453a'      // = --state-attention
export const USAGE_YELLOW = '#ff9f0a'   // = --state-warning
export const USAGE_GREEN = '#30d158'    // = --state-success

export function contextFillColor(usedPercent: number): string {
  if (usedPercent > 85) return USAGE_RED
  if (usedPercent >= 60) return USAGE_YELLOW
  return USAGE_GREEN
}

export interface UsagePillProps {
  /** Nama MODEL (mis. 'sonnet-4.6'), bukan judul node — judul sudah dirender di sebelahnya. */
  modelLabel?: string
  usedPercent?: number
}

export default function UsagePill({ modelLabel, usedPercent }: UsagePillProps): ReactNode {
  const pct = typeof usedPercent === 'number' ? Math.min(100, Math.max(0, usedPercent)) : null
  // Tanpa model DAN tanpa persen tidak ada yang bisa dilaporkan; pill kosong cuma menambah chrome.
  if (!modelLabel && pct === null) return null
  return (
    <Badge asChild variant="outline"><span className="usage-pill">
      {modelLabel && <span className="usage-pill__label">{modelLabel}</span>}
      {pct !== null && (
        <>
          <span className="usage-pill__minibar">
            <span className="usage-pill__fill" style={{ width: `${pct}%`, background: contextFillColor(pct) }} />
          </span>
          <span className="usage-pill__label">{Math.round(pct)}%</span>
        </>
      )}
    </span></Badge>
  )
}
