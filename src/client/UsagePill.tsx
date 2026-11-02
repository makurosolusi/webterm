import type { CSSProperties, ReactNode } from 'react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

// Fill color by % of context USED. Exported so logic has no bare hex (Rule 15).
export const USAGE_RED = '#ff453a'      // = --state-attention
export const USAGE_YELLOW = '#ff9f0a'   // = --state-warning
export const USAGE_GREEN = '#30d158'    // = --state-success

export type ContextFillLevel = 'ok' | 'warn' | 'hot'

/** Band warna menurut persen konteks terpakai. Ambang batasnya sengaja tetap di satu tempat. */
export function contextFillLevel(usedPercent: number): ContextFillLevel {
  if (usedPercent > 85) return 'hot'
  if (usedPercent >= 60) return 'warn'
  return 'ok'
}

export function contextFillColor(usedPercent: number): string {
  const level = contextFillLevel(usedPercent)
  if (level === 'hot') return USAGE_RED
  if (level === 'warn') return USAGE_YELLOW
  return USAGE_GREEN
}

// Warna fill dipilih lewat `data-level`, bukan nilai warna inline: kelasnya statis sehingga
// ter-scan build, dan token warnanya tetap milik stylesheet.
const FILL_CLASS: Record<ContextFillLevel, string> = {
  ok: 'data-[level=ok]:bg-[var(--state-success)]',
  warn: 'data-[level=warn]:bg-[var(--state-warning)]',
  hot: 'data-[level=hot]:bg-[var(--state-attention)]',
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
  const level = pct === null ? null : contextFillLevel(pct)
  return (
    <Badge asChild variant="outline"><span className="usage-pill">
      {modelLabel && <span className="usage-pill__label">{modelLabel}</span>}
      {pct !== null && level !== null && (
        <>
          <span className="usage-pill__minibar">
            {/* Satu-satunya nilai dinamis yang tak bisa jadi kelas statis: lebar fill mengikuti
                persen. Ia dikirim sebagai custom property dan dikonsumsi `w-[var(--usage-pct)]`;
                tak ada deklarasi layout lain yang inline. */}
            <span
              className={cn('usage-pill__fill w-[var(--usage-pct)]', FILL_CLASS[level])}
              data-level={level}
              style={{ '--usage-pct': `${pct}%` } as CSSProperties}
            />
          </span>
          <span className="usage-pill__label">{Math.round(pct)}%</span>
        </>
      )}
    </span></Badge>
  )
}
