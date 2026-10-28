import type { ReactNode } from 'react'

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
  modelLabel: string
  usedPercent?: number
}

export default function UsagePill({ modelLabel, usedPercent }: UsagePillProps): ReactNode {
  if (typeof usedPercent !== 'number') {
    return (
      <span className="usage-pill">
        <span className="usage-pill__label">{modelLabel}</span>
      </span>
    )
  }
  const pct = Math.min(100, Math.max(0, usedPercent))
  return (
    <span className="usage-pill">
      <span className="usage-pill__label">{modelLabel}</span>
      <span className="usage-pill__minibar">
        <span className="usage-pill__fill" style={{ width: `${pct}%`, background: contextFillColor(pct) }} />
      </span>
      <span className="usage-pill__label">{Math.round(pct)}%</span>
    </span>
  )
}
