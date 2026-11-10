// Turns nobody typed. A system turn is counted against the daily check-in budget here, at the only place one can start.
import type { Database } from 'bun:sqlite'
import { execWrite, getRow } from '../../ledger/ledgerCore'

/** How a self-started turn presents itself: `notice` is what the conversation shows, `dailyLimit` what the submit is checked against. */
export interface SystemTurnOrigin { kind: 'system'; notice: string; dailyLimit: number }

const HUMAN_LABEL = 'Human request:\n'

/** Midnight (local time) of the day containing `at`. */
export function localDayStart(at: number): number {
  const day = new Date(at)
  day.setHours(0, 0, 0, 0)
  return day.getTime()
}

/** Self-started turns begun on the local day of `at`. */
export function systemTurnsToday(db: Database, at: number): number {
  const start = new Date(localDayStart(at))
  const end = new Date(start)
  end.setDate(end.getDate() + 1)
  return Number(getRow(db, "SELECT COUNT(*) AS n FROM central_turn WHERE origin = 'system' AND started_at >= ? AND started_at < ?", start.getTime(), end.getTime())?.n ?? 0)
}

/** Records that `turnId` was self-started. */
export function markSystemTurn(db: Database, turnId: string): void {
  execWrite(db, "UPDATE central_turn SET origin = 'system' WHERE id = ?", turnId)
}

/** The assemblers label the closing block as the human's; a self-started turn has no human. */
export function withoutHumanLabel(prompt: string, text: string): string {
  const labelled = `${HUMAN_LABEL}${text}`
  return prompt.endsWith(labelled) ? `${prompt.slice(0, -labelled.length)}${text}` : prompt
}
